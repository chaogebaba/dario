import type { IncomingMessage, ServerResponse } from 'node:http';

import { isValidAccountAlias } from './account-alias.js';
import { removeAccount, renameAccountWithResult, setAccountEnabled, toggleAccountEnabled, type RenameAccountResult } from './account-store.js';
import { authCooldownMs, isInAuthCooldown, type AccountPool } from './pool.js';
import { fetchQuota, type QuotaSnapshot } from './quota.js';

// Two routes read a body now — rename and the explicit enabled-state set —
// so the bounds are named for mutations rather than for rename.
const MUTATION_BODY_LIMIT_BYTES = 8 * 1024;
const MUTATION_BODY_TIMEOUT_MS = 5_000;

export interface QuotaCacheEntry {
  at: number;
  snapshot: QuotaSnapshot;
}

export interface AccountRouteDependencies {
  pool: AccountPool;
  quotaCache: Map<string, QuotaCacheEntry>;
  quotaCacheMs: number;
  mutationBodyLimitBytes?: number;
  mutationBodyTimeoutMs?: number;
  jsonHeaders: Record<string, string>;
  isLoopbackAddress(address: string | undefined): boolean;
  reconcile(): Promise<number>;
  retryModelCatalog(): void;
  probePlans(): void;
  accountToggled?: (alias: string, enabled: boolean) => void;
  verbose?: boolean;
  log?: (message: string) => void;
  fetchQuota?: typeof fetchQuota;
}

type AccountMutation = {
  action: 'delete' | 'rename' | 'toggle' | 'enabled';
  alias: string | null;
};

class RequestBodyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: unknown,
): void {
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function renameFailure(result: Exclude<RenameAccountResult, 'renamed'>): {
  status: number;
  error: string;
} {
  switch (result) {
    case 'conflict': return { status: 409, error: 'account alias already exists' };
    case 'invalid': return { status: 400, error: 'invalid account alias' };
    case 'not-found': return { status: 404, error: 'account not found' };
    case 'internal': return { status: 500, error: 'account storage operation failed' };
  }
}

function requireLoopback(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AccountRouteDependencies,
  error: string,
): boolean {
  if (deps.isLoopbackAddress(req.socket?.remoteAddress)) return true;
  sendJson(res, 403, deps.jsonHeaders, {
    ok: false,
    error,
  });
  return false;
}

async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    onTimeout();
    req.destroy(new RequestBodyError(408, 'request body timed out'));
  }, timeoutMs);

  try {
    for await (const value of req) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      if (bytes > maxBytes) {
        req.resume();
        throw new RequestBodyError(413, `request body exceeds ${maxBytes / 1024} KiB limit`);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (timedOut) throw new RequestBodyError(408, 'request body timed out');
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('body is not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new RequestBodyError(400, 'invalid JSON request body');
  }
}

function accountStatus(pool: AccountPool): Record<string, unknown> {
  const now = Date.now();
  const accounts = pool.all().map((account) => {
    const inCooldown = isInAuthCooldown(account, now);
    const quotaCooldowns = Object.entries(account.rateLimitCooldowns)
      .filter(([, cooldown]) => cooldown.until > now);
    const cooldownMs = inCooldown && account.lastAuthFailureAt
      ? Math.max(0, authCooldownMs(account.consecutiveAuthFailures) - (now - account.lastAuthFailureAt))
      : quotaCooldowns.reduce((max, [, cooldown]) => Math.max(max, cooldown.until - now), 0);
    return {
      alias: account.alias,
      util5h: account.rateLimit.util5h,
      util7d: account.rateLimit.util7d,
      claim: account.rateLimit.claim,
      status: !account.enabled
        ? 'disabled'
        : inCooldown
        ? 'auth-cooldown'
        : quotaCooldowns.length > 0
        ? 'quota-cooldown'
        : account.refreshError
        ? 'refresh-failed'
        : account.rateLimit.status,
      requestCount: account.requestCount,
      expiresInMs: Math.max(0, account.expiresAt - now),
      expiresAt: account.expiresAt,
      enabled: account.enabled,
      ...(account.refreshError ? { refreshError: account.refreshError } : {}),
      measuredAt: account.rateLimit.updatedAt,
      ...(inCooldown || quotaCooldowns.length > 0
        ? {
            cooldownMs,
            ...(inCooldown
              ? {
                  lastAuthFailureAt: account.lastAuthFailureAt,
                  consecutiveAuthFailures: account.consecutiveAuthFailures,
                }
              : { cooldownScopes: quotaCooldowns.map(([scope]) => scope) }),
          }
        : {}),
    };
  });

  return {
    mode: 'pool',
    ...pool.status(),
    stickyBindings: pool.stickyCount(),
    accounts,
  };
}

async function quotaStatus(
  requestUrl: string | undefined,
  deps: AccountRouteDependencies,
): Promise<Record<string, unknown>> {
  const force = /[?&]refresh=1(&|$)/.test(requestUrl ?? '');
  const fetchAccountQuota = deps.fetchQuota ?? fetchQuota;
  const accounts = await Promise.all(deps.pool.all().map(async (account) => {
    const cached = deps.quotaCache.get(account.alias);
    if (account.enabled === false) {
      return {
        alias: account.alias,
        ...(cached?.snapshot ?? {
          windows: [],
          plan: account.plan ?? null,
          email: null,
          extraUsage: null,
          fetchedAt: Date.now(),
        }),
        cached: Boolean(cached),
        enabled: false,
        error: 'account disabled',
      };
    }
    if (!force && cached && Date.now() - cached.at < deps.quotaCacheMs) {
      return { alias: account.alias, ...cached.snapshot, cached: true };
    }

    try {
      const snapshot = await fetchAccountQuota(account.accessToken);
      if (deps.pool.get(account.alias) === account) {
        deps.quotaCache.set(account.alias, { at: Date.now(), snapshot });
        if (snapshot.plan) deps.pool.updatePlan(account.alias, snapshot.plan);
      }
      return { alias: account.alias, ...snapshot, cached: false };
    } catch (error) {
      return {
        alias: account.alias,
        windows: [],
        plan: null,
        email: null,
        extraUsage: null,
        fetchedAt: Date.now(),
        cached: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
  return { accounts };
}

async function reconcilePool(deps: AccountRouteDependencies): Promise<number> {
  const size = await deps.reconcile();
  deps.quotaCache.clear();
  if (size > 0) deps.retryModelCatalog();
  return size;
}

/**
 * Handle account and quota control-plane routes.
 *
 * Returns false when the route belongs to another proxy subsystem.
 */
export async function handleAccountRoute(
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
  deps: AccountRouteDependencies,
): Promise<boolean> {
  if (urlPath === '/pool/reconcile' && req.method === 'POST') {
    if (!requireLoopback(req, res, deps, 'pool reconciliation is loopback-only')) return true;
    try {
      const size = await reconcilePool(deps);
      if (deps.verbose) deps.log?.(`[dario] pool reconciled from TUI - ${size} account${size === 1 ? '' : 's'}`);
      sendJson(res, 200, deps.jsonHeaders, { ok: true, accounts: size });
      deps.probePlans();
    } catch (error) {
      sendJson(res, 500, deps.jsonHeaders, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  const mutation = parseAccountMutationPath(urlPath);
  if (mutation?.action === 'delete' && req.method === 'DELETE') {
    if (!requireLoopback(req, res, deps, 'account mutations are loopback-only')) return true;
    if (!isValidAccountAlias(mutation.alias)) {
      sendJson(res, 400, deps.jsonHeaders, { ok: false, error: 'invalid account alias' });
      return true;
    }

    try {
      const removed = await removeAccount(mutation.alias);
      if (removed) {
        await deps.reconcile();
        deps.quotaCache.delete(mutation.alias);
        if (deps.verbose) deps.log?.(`[dario] account "${mutation.alias}" removed via TUI`);
      }
      sendJson(res, removed ? 200 : 404, deps.jsonHeaders, { ok: removed, alias: mutation.alias });
    } catch (error) {
      sendJson(res, 500, deps.jsonHeaders, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (mutation?.action === 'rename' && req.method === 'POST') {
    if (!requireLoopback(req, res, deps, 'account mutations are loopback-only')) return true;
    if (!isValidAccountAlias(mutation.alias)) {
      sendJson(res, 400, deps.jsonHeaders, { ok: false, error: 'invalid account alias' });
      return true;
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(
        req,
        deps.mutationBodyLimitBytes ?? MUTATION_BODY_LIMIT_BYTES,
        deps.mutationBodyTimeoutMs ?? MUTATION_BODY_TIMEOUT_MS,
        () => {
          if (!res.headersSent) {
            sendJson(res, 408, deps.jsonHeaders, { ok: false, error: 'rename request body timed out' });
          }
        },
      );
    } catch (error) {
      const bodyError = error instanceof RequestBodyError
        ? error
        : new RequestBodyError(400, 'invalid request body');
      if (!res.headersSent) {
        sendJson(res, bodyError.status, deps.jsonHeaders, { ok: false, error: bodyError.message });
      }
      return true;
    }

    const newAlias = typeof body.newAlias === 'string' ? body.newAlias.trim() : '';
    if (!isValidAccountAlias(newAlias)) {
      sendJson(res, 400, deps.jsonHeaders, { ok: false, error: 'invalid or missing newAlias' });
      return true;
    }

    const result = await renameAccountWithResult(mutation.alias, newAlias);
    const renamed = result === 'renamed';
    if (renamed) {
      await deps.reconcile();
      deps.quotaCache.delete(mutation.alias);
      deps.quotaCache.delete(newAlias);
      if (deps.verbose) deps.log?.(`[dario] account "${mutation.alias}" renamed to "${newAlias}" via TUI`);
    }
    const failure = renamed ? null : renameFailure(result);
    sendJson(res, failure?.status ?? 200, deps.jsonHeaders, {
      ok: renamed,
      oldAlias: mutation.alias,
      newAlias,
      ...(failure ? { error: failure.error } : {}),
    });
    if (renamed) deps.probePlans();
    return true;
  }

  // `POST /accounts/:alias/enabled` sets the state the caller names;
  // `POST /accounts/:alias/toggle` flips whatever it finds. The set route
  // exists because the flip is not idempotent: a client timeout on a request
  // the server did apply, retried, inverts twice and lands back where it
  // started — or lands opposite to what the operator saw, if the retry raced
  // the original. There is no way for a flip to tell those apart, because the
  // request does not say what state it wanted. Toggle stays for the TUI's
  // single keypress and shares this handler; both go through the same
  // per-alias lock, so a flip cannot read a state a set is about to replace.
  if ((mutation?.action === 'toggle' || mutation?.action === 'enabled') && req.method === 'POST') {
    if (!requireLoopback(req, res, deps, 'account mutations are loopback-only')) return true;
    if (!isValidAccountAlias(mutation.alias)) {
      sendJson(res, 400, deps.jsonHeaders, { ok: false, error: 'invalid account alias' });
      return true;
    }

    let desired: boolean | null = null;
    if (mutation.action === 'enabled') {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(
          req,
          deps.mutationBodyLimitBytes ?? MUTATION_BODY_LIMIT_BYTES,
          deps.mutationBodyTimeoutMs ?? MUTATION_BODY_TIMEOUT_MS,
          () => {
            if (!res.headersSent) {
              sendJson(res, 408, deps.jsonHeaders, { ok: false, error: 'request body timed out' });
            }
          },
        );
      } catch (error) {
        const bodyError = error instanceof RequestBodyError
          ? error
          : new RequestBodyError(400, 'invalid request body');
        if (!res.headersSent) {
          sendJson(res, bodyError.status, deps.jsonHeaders, { ok: false, error: bodyError.message });
        }
        return true;
      }
      // Strictly boolean. Accepting "true" or 1 would make the route's whole
      // reason for existing — saying exactly which state you want — depend on
      // a coercion the caller cannot see, and `Boolean('false')` is true.
      if (typeof body.enabled !== 'boolean') {
        sendJson(res, 400, deps.jsonHeaders, { ok: false, error: 'missing or non-boolean `enabled`' });
        return true;
      }
      desired = body.enabled;
    }

    try {
      const updated = desired === null
        ? await toggleAccountEnabled(mutation.alias)
        : await setAccountEnabled(mutation.alias, desired);
      if (!updated) {
        sendJson(res, 404, deps.jsonHeaders, { ok: false, alias: mutation.alias });
        return true;
      }
      await deps.reconcile();
      deps.quotaCache.delete(mutation.alias);
      deps.accountToggled?.(mutation.alias, updated.enabled === true);
      deps.probePlans();
      // The route, not "via TUI": the TUI is one caller of two now, and the
      // log is the only record of which one asked.
      if (deps.verbose) {
        deps.log?.(`[dario] account "${mutation.alias}" ${updated.enabled ? 'enabled' : 'disabled'} via /${mutation.action}`);
      }
      sendJson(res, 200, deps.jsonHeaders, { ok: true, alias: mutation.alias, enabled: updated.enabled });
    } catch (error) {
      sendJson(res, 500, deps.jsonHeaders, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (urlPath === '/accounts' && req.method === 'GET') {
    sendJson(res, 200, deps.jsonHeaders, accountStatus(deps.pool));
    return true;
  }

  if (urlPath === '/quota' && req.method === 'GET') {
    sendJson(res, 200, deps.jsonHeaders, await quotaStatus(req.url, deps));
    return true;
  }

  return false;
}

export function parseAccountMutationPath(path: string): AccountMutation | null {
  const rename = /^\/accounts\/([^/]+)\/rename$/.exec(path);
  const toggle = rename ? null : /^\/accounts\/([^/]+)\/toggle$/.exec(path);
  const enabled = rename || toggle ? null : /^\/accounts\/([^/]+)\/enabled$/.exec(path);
  const remove = rename || toggle || enabled ? null : /^\/accounts\/([^/]+)$/.exec(path);
  const encoded = rename?.[1] ?? toggle?.[1] ?? enabled?.[1] ?? remove?.[1];
  if (encoded === undefined) return null;
  const action: AccountMutation['action'] = rename ? 'rename' : toggle ? 'toggle' : enabled ? 'enabled' : 'delete';
  try {
    return { action, alias: decodeURIComponent(encoded) || null };
  } catch {
    return { action, alias: null };
  }
}
