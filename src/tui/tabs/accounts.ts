/**
 * Accounts tab — interactive management of OAuth subscription accounts.
 *
 * Source of truth is the RUNNING PROXY's live pool (`GET /accounts`), not a
 * local disk read: the TUI is its own process, and in a containerized / admin
 * (#599) / login-less-pool (#630) deployment the accounts live in the proxy's
 * volume, so reading `~/.dario/accounts/` in the TUI process comes up empty
 * while the proxy serves several accounts fine (#641). We fall back to the disk
 * read only when the proxy is unreachable, and flag it so the user knows the
 * view may be stale.
 *
 * Interactive features:
 *   - Arrow keys navigate the account list
 *   - `r` refreshes AND reconciles the pool (hot-reload from disk)
 *   - `n` adds a new account (OAuth flow in background, then reconciles)
 *   - `d` deletes the selected account (with confirmation)
 *   - `e` edits the selected account's alias (inline rename)
 *
 * Layout:
 *
 *   Accounts
 *   alias               expires       util5h   util7d   status
 *   ──────────────────────────────────────────────────────────────────
 *   > default           7h 41m          12%      4%
 *     alt               expired          0%      0%
 *
 *   n add  d delete  e rename  r refresh
 */

import type { Tab, TabContext } from '../tab.js';
import { fg, dim, bold, brand, pad, truncate, progressBar, inverse } from '../render.js';
import { renderKvRow } from '../layout.js';
import { formatResetInstant, formatResetRelative, quotaBand, type QuotaWindow } from '../../quota.js';

/** One account's control-plane quota, as `GET /quota` returns it. */
export interface AccountQuota {
  windows: QuotaWindow[];
  plan: string | null;
  error?: string;
}

export interface AccountsState {
  loading: boolean;
  accounts: Array<{
    alias: string;
    expiresAt: number;
    /** Live pool fields — present when sourced from the proxy's `/accounts`. */
    util5h?: number;
    util7d?: number;
    status?: string;
    measuredAt?: number;
    quota?: AccountQuota;
  }>;
  error: string | null;
  source?: 'pool' | 'single-account' | 'disk';
  /** Index of the currently selected account in the list. */
  selectedIdx: number;
  /** Interaction mode: normal browsing, confirming a delete, or editing an alias. */
  mode: 'normal' | 'confirm-delete' | 'edit-alias' | 'adding';
  /** Edit buffer for alias rename. */
  editBuffer: string | null;
  /** Feedback message shown after an action. */
  message: string | null;
  messageKind: 'success' | 'error' | 'info' | null;
}

/** Shape of the proxy's `GET /accounts` response (see src/proxy.ts). */
interface AccountsEndpoint {
  mode?: 'pool' | 'single-account';
  accounts?: Array<{
    alias: string;
    expiresInMs?: number;
    expiresAt?: number;
    util5h?: number;
    util7d?: number;
    status?: string;
    measuredAt?: number;
  }>;
}

export const AccountsTab: Tab<AccountsState> = {
  id: 'accounts',
  label: 'Accounts',
  hotkey: 'a',

  initialState(): AccountsState {
    return {
      loading: true,
      accounts: [],
      error: null,
      selectedIdx: 0,
      mode: 'normal',
      editBuffer: null,
      message: null,
      messageKind: null,
    };
  },

  async onMount(_state, ctx: TabContext): Promise<AccountsState | undefined> {
    return refreshAccounts(ctx);
  },

  onKey(state, key) {
    // ── Edit-alias mode: capture typed characters ──────────────
    if (state.mode === 'edit-alias') {
      if (key.name === 'escape') {
        return { ...state, mode: 'normal' as const, editBuffer: null, message: null, messageKind: null };
      }
      if (key.name === 'enter') {
        // Keep editBuffer so onTick can read it for the rename.
        return { ...state, mode: 'normal' as const, message: 'Renaming…', messageKind: 'info' as const };
      }
      if (key.name === 'backspace') {
        const buf = state.editBuffer ?? '';
        return { ...state, editBuffer: buf.slice(0, -1) };
      }
      if (key.name === 'printable' && key.ch && !key.ctrl) {
        const buf = state.editBuffer ?? '';
        return { ...state, editBuffer: buf + key.ch };
      }
      return undefined;
    }

    // ── Confirm-delete mode ───────────────────────────────────
    if (state.mode === 'confirm-delete') {
      if (key.name === 'printable' && (key.ch === 'y' || key.ch === 'Y')) {
        // Signal delete — the tick handler will fire it.
        return { ...state, mode: 'normal' as const, message: 'Deleting…', messageKind: 'info' as const };
      }
      // Any other key cancels.
      return { ...state, mode: 'normal' as const, message: null, messageKind: null };
    }

    // ── Adding mode: just waiting ─────────────────────────────
    if (state.mode === 'adding') {
      // No keys accepted while the add flow is running.
      return undefined;
    }

    // ── Normal mode ───────────────────────────────────────────
    // Arrow navigation
    if (key.name === 'up' && state.accounts.length > 0) {
      const idx = Math.max(0, state.selectedIdx - 1);
      return { ...state, selectedIdx: idx };
    }
    if (key.name === 'down' && state.accounts.length > 0) {
      const idx = Math.min(state.accounts.length - 1, state.selectedIdx + 1);
      return { ...state, selectedIdx: idx };
    }

    // `r` — refresh + reconcile
    if (key.name === 'printable' && key.ch === 'r' && !key.ctrl) {
      forceQuota = true;
      doReconcile = true;
      return { ...state, loading: true, message: null, messageKind: null };
    }

    // `n` — add new account
    if (key.name === 'printable' && key.ch === 'n' && !key.ctrl) {
      doAdd = true;
      return { ...state, mode: 'adding' as const, message: 'Starting OAuth flow…', messageKind: 'info' as const };
    }

    // `d` or `x` — delete selected account
    if (key.name === 'printable' && (key.ch === 'd' || key.ch === 'x') && !key.ctrl) {
      if (state.accounts.length === 0) return undefined;
      const alias = state.accounts[state.selectedIdx]?.alias;
      if (!alias) return undefined;
      return { ...state, mode: 'confirm-delete' as const, message: `Delete "${alias}"? Press y to confirm, any other key to cancel.`, messageKind: 'info' as const };
    }

    // `e` — edit alias
    if (key.name === 'printable' && key.ch === 'e' && !key.ctrl) {
      if (state.accounts.length === 0) return undefined;
      const alias = state.accounts[state.selectedIdx]?.alias;
      if (!alias) return undefined;
      return { ...state, mode: 'edit-alias' as const, editBuffer: alias, message: null, messageKind: null };
    }

    return undefined;
  },

  onTick(state, ctx) {
    // Drive async side-effects that onKey can't fire directly.

    // Refresh + reconcile
    if (state.loading && !refreshInFlight) {
      refreshInFlight = true;
      const force = forceQuota;
      const reconcile = doReconcile;
      forceQuota = false;
      doReconcile = false;
      void (async () => {
        if (reconcile) {
          await ctx.client.reconcilePool();
        }
        return refreshAccounts(ctx, force);
      })()
        .then((next) => ctx.setState(next))
        .finally(() => { refreshInFlight = false; });
    }

    // Add account flow
    if (doAdd && state.mode === 'adding') {
      doAdd = false;
      void performAdd(ctx);
    }

    // Delete (after confirm)
    if (state.mode === 'normal' && state.message === 'Deleting…') {
      const alias = state.accounts[state.selectedIdx]?.alias;
      if (alias) {
        void performDelete(ctx, alias, state.selectedIdx);
      }
    }

    // Rename (after Enter in edit mode)
    if (state.mode === 'normal' && state.message === 'Renaming…' && state.editBuffer !== null) {
      const oldAlias = state.accounts[state.selectedIdx]?.alias;
      const newAlias = state.editBuffer;
      if (oldAlias && newAlias) {
        // Clear editBuffer to prevent re-trigger on next tick.
        ctx.setState({ editBuffer: null } as Partial<AccountsState>);
        void performRename(ctx, oldAlias, newAlias);
      }
    }
  },

  render(state, dimv): string {
    const lines: string[] = [];
    const w = dimv.cols;
    const push = (s: string) => lines.push(truncate(s, w));

    push(' ' + brand('Accounts'));

    if (state.loading && state.accounts.length === 0) {
      push('');
      push('  ' + dim('Loading accounts…'));
      return lines.join('\n');
    }

    if (state.accounts.length === 0) {
      push('');
      if (state.source === 'single-account') {
        push('  ' + dim('Single-account mode (`dario login`) — no pool.'));
        push('  ' + 'Start a pool: press ' + fg('cyan', 'n') + ' or run ' + fg('cyan', 'dario accounts add <alias>'));
      } else {
        push('  ' + dim('No accounts in the pool.'));
        push('  ' + 'Add one: press ' + fg('cyan', 'n') + ' or run ' + fg('cyan', 'dario accounts add <alias>'));
      }
      if (state.message) {
        push('');
        const c = state.messageKind === 'error' ? 'red' : state.messageKind === 'success' ? 'green' : 'cyan';
        push('  ' + fg(c, state.message));
      }
      push('');
      push(' ' + dim(`${fg('cyan', 'n')} add  ${fg('cyan', 'r')} refresh`));
      return lines.join('\n');
    }

    if (state.source === 'disk') {
      push('  ' + fg('yellow', 'proxy unreachable — showing on-disk accounts (may be stale)'));
    }

    // Control-plane quota is the preferred view — it exists without traffic
    // and carries per-window resets. The header-derived util table stays as
    // the fallback for a proxy that predates /quota or whose fetch failed.
    const hasQuota = state.accounts.some((a) => (a.quota?.windows?.length ?? 0) > 0);
    if (hasQuota) {
      renderQuotaCards(state, push, w);
    } else {
      renderUtilTable(state, push, w);
    }

    // ── Message area ──────────────────────────────────────────
    if (state.mode === 'edit-alias') {
      push('');
      push('  ' + bold('Rename alias: ') + (state.editBuffer ?? '') + fg('cyan', '_'));
      push('  ' + dim('Enter to confirm, Esc to cancel'));
    } else if (state.message) {
      push('');
      const c = state.messageKind === 'error' ? 'red' : state.messageKind === 'success' ? 'green' : 'cyan';
      push('  ' + fg(c, state.message));
    }

    // ── Footer key hints ──────────────────────────────────────
    push('');
    const normalMode = !state.mode || state.mode === 'normal';
    const hints = normalMode
      ? ` ${fg('cyan', 'n')} add  ${fg('cyan', 'd')} delete  ${fg('cyan', 'e')} rename  ${fg('cyan', 'r')} refresh quota`
      : '';
    push(dim(hints));

    return lines.join('\n');
  },
};

/**
 * The quota card layout — unchanged from the previous read-only implementation.
 */
function renderQuotaCards(
  state: AccountsState,
  push: (s: string) => void,
  w: number,
): void {
  const now = Date.now();
  const labelWidth = Math.max(
    14,
    ...state.accounts.flatMap((a) => (a.quota?.windows ?? []).map((win) => win.label.length)),
  );
  const barWidth = Math.max(8, Math.min(w - 8, 56));

  for (let i = 0; i < state.accounts.length; i++) {
    const acc = state.accounts[i]!;
    const selected = i === state.selectedIdx;
    push('');
    const marker = selected ? fg('cyan', '>') : ' ';
    const expiry = formatExpiry(acc.expiresAt);
    const planPart = acc.quota?.plan ? dim('Plan ') + bold(acc.quota.plan) : '';
    const header = `${marker} ${selected ? bold(acc.alias) : acc.alias}  ${dim('token ')}${expiry}${planPart ? '   ' + planPart : ''}`;
    push('  ' + header);

    if (acc.quota?.error) {
      push('    ' + fg('yellow', 'quota unavailable: ') + dim(acc.quota.error));
      continue;
    }

    for (const win of acc.quota?.windows ?? []) {
      const pctText = win.remainingPercent === null
        ? '--'
        : `${Math.round(win.remainingPercent)}%`;
      const rel = formatResetRelative(win.resetsAt, now);
      const reset = win.resetsAt === null
        ? ''
        : `${formatResetInstant(win.resetsAt)}${rel ? ` · ${rel}` : ''}`;
      push('    ' + pad(win.label, labelWidth) + ' ' + pad(bold(pctText), 6, 'right')
        + (reset ? '   ' + dim(reset) : ''));
      push('    ' + meter(win.remainingPercent, barWidth));
    }
  }
}

/** Colored meter over the REMAINING fraction. */
function meter(remainingPercent: number | null, width: number): string {
  const band = quotaBand(remainingPercent);
  const bar = progressBar((remainingPercent ?? 0) / 100, width);
  if (band === 'unknown') return dim(bar);
  const color = band === 'high' ? 'green' : band === 'medium' ? 'yellow' : 'red';
  const cells = Math.round(Math.max(0, Math.min(1, (remainingPercent ?? 0) / 100)) * width);
  return fg(color, bar.slice(0, cells)) + dim(bar.slice(cells));
}

/**
 * Pre-/quota fallback: the header-derived utilization table with selection cursor.
 */
function renderUtilTable(
  state: AccountsState,
  push: (s: string) => void,
  w: number,
): void {
  const hasUtil = state.accounts.some((a) => a.util5h !== undefined);

  push('  ' + dim(
    hasUtil
      ? '  ' + pad('alias', 20) + pad('expires', 14) + pad('util5h', 9) + pad('util7d', 9) + pad('status', 14)
      : '  ' + pad('alias', 20) + pad('expires', 16) + pad('source', 24)
  ));
  push('  ' + dim('─'.repeat(Math.min(w - 4, 68))));

  for (let i = 0; i < state.accounts.length; i++) {
    const acc = state.accounts[i]!;
    const selected = i === state.selectedIdx;

    const aliasCol = pad(acc.alias, 20);
    if (hasUtil) {
      const expiresCol = pad(formatExpiry(acc.expiresAt), 14);
      const seen = isMeasured(acc);
      const u5 = pad(seen ? `${Math.round((acc.util5h ?? 0) * 100)}%` : '—', 9);
      const u7 = pad(seen ? `${Math.round((acc.util7d ?? 0) * 100)}%` : '—', 9);
      const statusCol = acc.status ?? '—';
      const statusFg = statusCol === 'auth-cooldown' ? fg('yellow', statusCol) : dim(statusCol);
      const row = '  ' + aliasCol + expiresCol + u5 + u7 + statusFg;
      push(selected ? fg('cyan', '>') + row.slice(1) : row);
    } else {
      const expiresCol = pad(formatExpiry(acc.expiresAt), 16);
      const sourceCol = '~/.dario/accounts/' + acc.alias + '.json';
      const row = '  ' + aliasCol + expiresCol + dim(sourceCol);
      push(selected ? fg('cyan', '>') + row.slice(1) : row);
    }
  }

  if (hasUtil && !state.accounts.some(isMeasured)) {
    push('');
    push('  ' + dim('util is read from proxied responses — none seen yet this run.'));
    push('  ' + dim('For a reading now: ') + fg('cyan', 'dario doctor --usage'));
  }
}

// ── Async side-effect flags ─────────────────────────────────────────

let refreshInFlight = false;
let forceQuota = false;
let doReconcile = false;
let doAdd = false;

function isMeasured(acc: AccountsState['accounts'][number]): boolean {
  if (acc.measuredAt !== undefined) return acc.measuredAt > 0;
  return acc.util5h !== undefined;
}

/** Shape of the proxy's `GET /quota` response. */
interface QuotaEndpoint {
  accounts?: Array<{ alias: string; windows?: QuotaWindow[]; plan?: string | null; error?: string }>;
}

async function fetchQuotaMap(
  ctx: TabContext<AccountsState>,
  force: boolean,
): Promise<Map<string, AccountQuota>> {
  const out = new Map<string, AccountQuota>();
  try {
    const q = await ctx.client.getJson<QuotaEndpoint>(force ? '/quota?refresh=1' : '/quota');
    for (const a of q.accounts ?? []) {
      out.set(a.alias, { windows: a.windows ?? [], plan: a.plan ?? null, ...(a.error ? { error: a.error } : {}) });
    }
  } catch { /* endpoint missing or unreachable */ }
  return out;
}

// ── Core refresh ────────────────────────────────────────────────────

export async function refreshAccounts(
  ctx?: TabContext<AccountsState>,
  forceQuotaRefresh = false,
): Promise<AccountsState> {
  if (ctx) {
    try {
      const r = await ctx.client.getJson<AccountsEndpoint>('/accounts');
      if (r.mode === 'single-account') {
        return { loading: false, accounts: [], error: null, source: 'single-account', selectedIdx: 0, mode: 'normal', editBuffer: null, message: null, messageKind: null };
      }
      if (Array.isArray(r.accounts)) {
        const now = Date.now();
        const quota = await fetchQuotaMap(ctx, forceQuotaRefresh);
        return {
          loading: false,
          source: 'pool',
          accounts: r.accounts.map((a) => ({
            alias: a.alias,
            expiresAt: a.expiresAt ?? now + (a.expiresInMs ?? 0),
            util5h: a.util5h,
            util7d: a.util7d,
            status: a.status,
            measuredAt: a.measuredAt,
            ...(quota.has(a.alias) ? { quota: quota.get(a.alias)! } : {}),
          })),
          error: null,
          selectedIdx: 0,
          mode: 'normal',
          editBuffer: null,
          message: null,
          messageKind: null,
        };
      }
    } catch {
      return diskFallback();
    }
  }
  return diskFallback();
}

async function diskFallback(): Promise<AccountsState> {
  try {
    const { listAccountAliases, loadAllAccounts } = await import('../../accounts.js');
    const aliases = await listAccountAliases();
    if (aliases.length === 0) {
      return { loading: false, accounts: [], error: null, source: 'disk', selectedIdx: 0, mode: 'normal', editBuffer: null, message: null, messageKind: null };
    }
    const all = await loadAllAccounts();
    return {
      loading: false,
      source: 'disk',
      accounts: all.map((a) => ({ alias: a.alias, expiresAt: a.expiresAt })),
      error: null,
      selectedIdx: 0,
      mode: 'normal',
      editBuffer: null,
      message: null,
      messageKind: null,
    };
  } catch (e) {
    return { loading: false, accounts: [], error: (e as Error).message, source: 'disk', selectedIdx: 0, mode: 'normal', editBuffer: null, message: null, messageKind: null };
  }
}

// ── Async action handlers ───────────────────────────────────────────

/**
 * Add a new account: spawns `dario accounts add` (which uses email as default
 * alias), waits for it to complete, then reconciles the pool.
 */
async function performAdd(ctx: TabContext<AccountsState>): Promise<void> {
  try {
    const { spawn } = await import('node:child_process');
    const { join } = await import('node:path');
    const { homeDir } = await import('../../home-dir.js');
    const { readFile } = await import('node:fs/promises');

    // Resolve an alias from ~/.claude.json email, same as the CLI does.
    let alias = '';
    try {
      const raw = await readFile(join(homeDir(), '.claude.json'), 'utf-8');
      const data = JSON.parse(raw);
      const email: string | undefined = data.oauthAccount?.emailAddress;
      if (email && typeof email === 'string') {
        alias = email.replace(/@/g, '.').replace(/[^a-zA-Z0-9._-]/g, '');
      }
    } catch { /* no email available */ }

    // Use the same binary that launched the TUI.
    const childArgs = ['accounts', 'add'];
    if (alias) childArgs.push(alias);

    const child = spawn(process.argv[0]!, [process.argv[1]!, ...childArgs], {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();

    // Wait for the OAuth flow to complete (up to 5 minutes).
    await new Promise<void>((resolve) => {
      child.on('exit', () => resolve());
      setTimeout(() => resolve(), 5 * 60_000);
    });

    // Reconcile the pool to pick up the new account.
    await ctx.client.reconcilePool();

    // Refresh the display.
    const next = await refreshAccounts(ctx, true);
    ctx.setState({ ...next, message: alias ? `Account "${alias}" added.` : 'Account added.', messageKind: 'success' } as Partial<AccountsState>);
  } catch (e) {
    ctx.setState({ mode: 'normal', loading: false, message: `Add failed: ${(e as Error).message}`, messageKind: 'error' } as Partial<AccountsState>);
  }
}

async function performDelete(ctx: TabContext<AccountsState>, alias: string, idx: number): Promise<void> {
  try {
    const result = await ctx.client.removeAccount(alias);
    if (result?.ok) {
      const next = await refreshAccounts(ctx, false);
      const newIdx = Math.min(idx, Math.max(0, next.accounts.length - 1));
      ctx.setState({ ...next, selectedIdx: newIdx, message: `Removed "${alias}".`, messageKind: 'success' } as Partial<AccountsState>);
    } else {
      ctx.setState({ message: `Failed to remove "${alias}".`, messageKind: 'error', mode: 'normal' } as Partial<AccountsState>);
    }
  } catch (e) {
    ctx.setState({ message: `Delete failed: ${(e as Error).message}`, messageKind: 'error', mode: 'normal' } as Partial<AccountsState>);
  }
}

async function performRename(ctx: TabContext<AccountsState>, oldAlias: string, newAlias: string): Promise<void> {
  if (!newAlias || !/^[a-zA-Z0-9._-]+$/.test(newAlias)) {
    ctx.setState({ message: 'Invalid alias — use letters, numbers, dot, dash, underscore.', messageKind: 'error', editBuffer: null } as Partial<AccountsState>);
    return;
  }
  if (oldAlias === newAlias) {
    ctx.setState({ message: null, messageKind: null, editBuffer: null } as Partial<AccountsState>);
    return;
  }
  try {
    const result = await ctx.client.renameAccount(oldAlias, newAlias);
    if (result?.ok) {
      const next = await refreshAccounts(ctx, false);
      ctx.setState({ ...next, message: `Renamed "${oldAlias}" → "${newAlias}".`, messageKind: 'success', editBuffer: null } as Partial<AccountsState>);
    } else {
      ctx.setState({ message: `Rename failed.`, messageKind: 'error', editBuffer: null } as Partial<AccountsState>);
    }
  } catch (e) {
    ctx.setState({ message: `Rename failed: ${(e as Error).message}`, messageKind: 'error', editBuffer: null } as Partial<AccountsState>);
  }
}

function formatExpiry(expiresAt: number): string {
  if (expiresAt === 0) return dim('—');
  const remainingMs = expiresAt - Date.now();
  if (remainingMs < 0) return fg('yellow', 'expired');
  const hours = Math.floor(remainingMs / 3_600_000);
  const minutes = Math.floor((remainingMs % 3_600_000) / 60_000);
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return fg('green', `${days}d ${hours % 24}h`);
  }
  if (hours > 0) return fg('green', `${hours}h ${minutes}m`);
  return fg('green', `${minutes}m`);
}
