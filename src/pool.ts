/**
 * Account pool — rate limit tracking, headroom routing, failover.
 *
 * Activated automatically when `~/.dario/accounts/` contains any account
 * (one is enough — dario#618). Login-only dario (`~/.dario/credentials.json`,
 * no accounts/ entries) keeps the same code path it has always had.
 */
import { createHash, randomUUID } from 'node:crypto';

/**
 * Compute a stable stickiness key from a conversation's first user
 * message. Multi-turn agent sessions carry the same first user message
 * on every turn, so hashing it gives a stable per-conversation key that
 * doesn't require client cooperation. Empty / whitespace-only inputs
 * return null so callers bypass stickiness on unhashable requests.
 *
 * Uses SHA-256 truncated to 16 hex chars (64 bits) — plenty of collision
 * headroom for a pool of at most a few hundred active conversations per
 * proxy instance, and small enough to log without spam.
 */
export function computeStickyKey(firstUserMessage: string | null | undefined): string | null {
  const trimmed = (firstUserMessage ?? '').trim();
  if (trimmed.length === 0) return null;
  return createHash('sha256').update(trimmed).digest('hex').slice(0, 16);
}

export interface AccountIdentity {
  deviceId: string;
  accountUuid: string;
  sessionId: string;
}

export interface RateLimitSnapshot {
  status: string;
  util5h: number;
  util7d: number;
  /**
   * Per-model 7-day utilization buckets — Anthropic carves separate
   * weekly windows for some model families. As of 2026-04-25 the live
   * API emits `anthropic-ratelimit-unified-7d_sonnet-utilization` on
   * Sonnet responses (corresponds to the "Sonnet only" line on the user
   * dashboard); other families do not yet have dedicated buckets but
   * the parser scans the header set generically so any future
   * `7d_<family>` header is captured automatically.
   *
   * Keyed by the family suffix as it arrived on the wire (lowercase,
   * e.g. `sonnet` / `opus` / `haiku`). Empty when no per-model headers
   * were on the response.
   */
  perModel7d: Record<string, number>;
  overageUtil: number;
  claim: string;
  reset: number;
  fallbackPct: number;
  updatedAt: number;
  /**
   * Whether the response this snapshot came from actually carried
   * rate-limit headers. `false` means every numeric field below is a
   * placeholder zero, not a measurement.
   *
   * The distinction is load-bearing in two places. Upstream responses that
   * carry no rate-limit headers at all are routine — 401 on an expired
   * token, 400 on a malformed body, 5xx from the edge — and treating their
   * all-zero parse as a measurement wiped the account's real utilization
   * back to 0% (`updateRateLimits` below refuses to). And a pool account
   * that has never served a request has to render as `—`, not `0%`: an
   * operator who reads "0% used" on a freshly restarted proxy concludes
   * their quota is untouched when dario simply has not looked yet.
   */
  measured: boolean;
}

export const EMPTY_SNAPSHOT: RateLimitSnapshot = {
  status: 'unknown',
  util5h: 0,
  util7d: 0,
  perModel7d: {},
  overageUtil: 0,
  claim: 'unknown',
  reset: 0,
  fallbackPct: 0,
  updatedAt: 0,
  measured: false,
};

export interface PoolAccount {
  alias: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  identity: AccountIdentity;
  rateLimit: RateLimitSnapshot;
  requestCount: number;
  enabled: boolean;
  refreshError?: string;
  /** Subscription plan: 'Max' | 'Pro' | 'Team' | 'Free' | null (unknown). */
  plan?: string | null;
  /**
   * Auth-failure cool-down (dario#234). Set when an upstream returns
   * 401/403 or an `authentication_error` / `permission_error` /
   * `invalid_grant` body — tokens are server-invalidated and the
   * selector should route around this account until either:
   *   (a) a successful request on this account clears the cool-down, or
   *   (b) the cool-down window expires
   *
   * Without this, the selector keeps picking the dead account because
   * 401 responses don't include rate-limit headers, so headroom math
   * sees a healthy idle account. Reproed live with a stale `login`
   * back-fill against an OAuth-derived account: pool routed every
   * request to the dead login and never tried the healthy peer.
   */
  lastAuthFailureAt?: number;
  consecutiveAuthFailures: number;
  /** Monotonic auth-failure version used to ignore stale successes. */
  authFailureEpoch: number;
  /** Per-model quota cooldowns established by 429 responses. */
  rateLimitCooldowns: Record<string, RateLimitCooldown>;
  /** Monotonic rejection version used to ignore stale concurrent successes. */
  rejectionEpoch: number;
}

interface RateLimitCooldown {
  until: number;
  backoffLevel: number;
}

/**
 * Cool-down schedule after auth failures. First failure: 60s. Each
 * consecutive failure doubles the window up to 30 minutes. Cleared
 * by any successful response on the same account. Numbers are tunable
 * — the shape is the design.
 */
const AUTH_COOLDOWN_BASE_MS = 60 * 1000;
const AUTH_COOLDOWN_MAX_MS = 30 * 60 * 1000;

export function authCooldownMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  const ms = AUTH_COOLDOWN_BASE_MS * Math.pow(2, consecutiveFailures - 1);
  return Math.min(ms, AUTH_COOLDOWN_MAX_MS);
}

export function isInAuthCooldown(account: PoolAccount, now: number = Date.now()): boolean {
  if (!account.lastAuthFailureAt || account.consecutiveAuthFailures <= 0) return false;
  const cooldown = authCooldownMs(account.consecutiveAuthFailures);
  return now - account.lastAuthFailureAt < cooldown;
}

/**
 * Why `select()` would skip this account, or null when it is eligible.
 *
 * The predicate `select()` filters on, named and reusable so a diagnostic can
 * ask the same question the router asks instead of re-deriving it. `dario
 * doctor` reported `next: login` for a token that had expired three months
 * earlier: select() falls back to an ineligible account rather than returning
 * null, so the answer was accurate about select()'s return value and wrong
 * about what would happen if you sent a request — which is the only thing the
 * operator reading that line wanted to know.
 *
 * Order matters for the message, not for the outcome. An expired token is the
 * cause an operator can act on, and it is upstream of the auth cool-down that
 * the first doomed request provokes, so it is reported in preference to it.
 */
export type IneligibleReason = 'disabled' | 'expired' | 'auth-cooldown' | 'rate-limited';

export function ineligibleReason(
  account: PoolAccount,
  now: number = Date.now(),
  family?: string | null,
): IneligibleReason | null {
  if (account.enabled === false) return 'disabled';
  if (account.expiresAt <= now + 30_000) return 'expired';
  if (isInAuthCooldown(account, now)) return 'auth-cooldown';
  if (isInRateLimitCooldown(account, family, now)) return 'rate-limited';
  return null;
}

const RATE_LIMIT_COOLDOWN_BASE_MS = 1_000;
const RATE_LIMIT_COOLDOWN_MAX_MS = 30 * 60 * 1000;
const RATE_LIMIT_HINT_MAX_MS = 8 * 24 * 60 * 60 * 1000;
const GLOBAL_RATE_LIMIT_SCOPE = '*';

function rateLimitScope(family?: string | null): string {
  return family?.trim().toLowerCase() || GLOBAL_RATE_LIMIT_SCOPE;
}

export function rateLimitCooldownMs(backoffLevel: number): number {
  const level = Math.max(0, Math.floor(backoffLevel));
  return Math.min(RATE_LIMIT_COOLDOWN_BASE_MS * Math.pow(2, level), RATE_LIMIT_COOLDOWN_MAX_MS);
}

export function isInRateLimitCooldown(
  account: PoolAccount,
  family?: string | null,
  now: number = Date.now(),
): boolean {
  const global = account.rateLimitCooldowns?.[GLOBAL_RATE_LIMIT_SCOPE];
  if (global && global.until > now) return true;
  const scoped = account.rateLimitCooldowns?.[rateLimitScope(family)];
  return Boolean(scoped && scoped.until > now);
}

function hasActiveRateLimitCooldown(account: PoolAccount, now: number): boolean {
  return Object.values(account.rateLimitCooldowns ?? {}).some((cooldown) => cooldown.until > now);
}

function rejectionCooldownScope(snapshot: RateLimitSnapshot, family?: string | null): string {
  if (!family) return GLOBAL_RATE_LIMIT_SCOPE;
  const unifiedExhausted = Math.max(snapshot.util5h, snapshot.util7d) >= 1 - POOL_HEADROOM_FLOOR;
  const familyExhausted = (snapshot.perModel7d[family] ?? 0) >= 1 - POOL_HEADROOM_FLOOR;
  return familyExhausted && !unifiedExhausted ? rateLimitScope(family) : GLOBAL_RATE_LIMIT_SCOPE;
}

export interface PoolStatus {
  accounts: number;
  healthy: number;
  exhausted: number;
  totalHeadroom: number;
  bestAccount: string;
  queued: number;
}

/**
 * Pool routing strategy.
 *
 * `headroom` (default) — every selection picks the account with the most
 * headroom, spreading new conversations across all seats.
 *
 * `fill-first` — concentrate new conversations on the lexicographically-
 * first eligible account (by alias) until its headroom drops to the 2%
 * floor, then spill to the next. Two things headroom spreading can't give
 * you: primary/backup semantics (a `z-backup` seat stays untouched until
 * `a-main` is actually drained), and cache concentration (every fresh
 * conversation lands where the prompt-cache pressure already is, keeping
 * the spill seat's windows fully fresh for when they're needed). Alias
 * order is the operator's knob — name seats `1-main` / `2-overflow` to
 * pick the fill order. Sticky bindings behave identically in both modes;
 * strategy only decides where UNBOUND (new) conversations land.
 */
export type PoolStrategy = 'headroom' | 'fill-first' | 'round-robin';

/**
 * Resolve the pool strategy from an explicit value (CLI flag / config file,
 * already precedence-merged by the caller) with `DARIO_POOL_STRATEGY` as
 * the env fallback. Unrecognized values fall through — a typo behaves like
 * the default rather than crashing startup, matching the other resolvers
 * in this codebase (see resolveSessionRotationConfig).
 */
export function resolvePoolStrategy(
  explicit?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): PoolStrategy {
  for (const c of [explicit, env.DARIO_POOL_STRATEGY]) {
    if (typeof c !== 'string') continue;
    const s = c.trim().toLowerCase();
    if (s === 'headroom' || s === 'fill-first' || s === 'round-robin') return s;
  }
  return 'headroom';
}

interface QueuedRequest {
  resolve: (account: PoolAccount) => void;
  reject: (error: Error) => void;
  enqueuedAt: number;
}

/**
 * Match `anthropic-ratelimit-unified-7d_<family>-utilization`. Generic on
 * `<family>` so a future `7d_opus` / `7d_haiku` (or anything Anthropic
 * adds without notice) is captured automatically. The family is
 * normalized to lowercase to match `modelFamily()` output.
 */
const PER_MODEL_7D_HEADER = /^anthropic-ratelimit-unified-7d_([a-z0-9-]+)-utilization$/i;

/**
 * Did this response carry rate-limit headers at all?
 *
 * Anthropic attaches them to anything that reached the subscription
 * accounting layer, and to nothing else — a 401 on a dead token, a 400 on a
 * bad body, a 502 from the edge all come back bare. `parseRateLimits` maps a
 * bare response to all-zeros, which is indistinguishable from a genuinely
 * idle account, so callers need this to know whether the parse is a
 * measurement or a placeholder. `doctor --usage` has always applied the same
 * test before trusting a probe response.
 *
 * The utilization headers are checked alongside `status` because that is the
 * field we actually read; a future response that carries one without the
 * other still counts as measured.
 */
export function hasRateLimitHeaders(headers: Headers): boolean {
  return (
    headers.get('anthropic-ratelimit-unified-status') !== null ||
    headers.get('anthropic-ratelimit-unified-5h-utilization') !== null ||
    headers.get('anthropic-ratelimit-unified-7d-utilization') !== null
  );
}

/** Parse an Anthropic response's rate-limit headers into a snapshot. */
export function parseRateLimits(headers: Headers): RateLimitSnapshot {
  const get = (key: string) => headers.get(`anthropic-ratelimit-unified-${key}`) ?? '';
  const perModel7d: Record<string, number> = {};
  // Iterate the full header set — `headers.get` only retrieves known
  // keys, but Anthropic can add new `7d_<family>-utilization` shapes
  // unannounced. Scanning the iterator means the parser is automatically
  // forward-compatible. Real `Headers` instances and test-side mocks
  // (which implement `.entries()` but not direct iteration) both work
  // through the explicit `.entries()` call.
  const entries = (typeof headers.entries === 'function')
    ? headers.entries()
    : (headers as unknown as Iterable<[string, string]>);
  for (const [k, v] of entries as Iterable<[string, string]>) {
    const m = k.match(PER_MODEL_7D_HEADER);
    if (m && m[1]) {
      perModel7d[m[1].toLowerCase()] = parseFloat(v) || 0;
    }
  }
  return {
    status: get('status') || 'unknown',
    util5h: parseFloat(get('5h-utilization')) || 0,
    util7d: parseFloat(get('7d-utilization')) || 0,
    perModel7d,
    overageUtil: parseFloat(get('overage-utilization')) || 0,
    claim: get('representative-claim') || 'unknown',
    reset: parseInt(get('reset')) || 0,
    fallbackPct: parseFloat(get('fallback-percentage')) || 0,
    updatedAt: Date.now(),
    measured: hasRateLimitHeaders(headers),
  };
}

/**
 * Extract the model family (`opus` / `sonnet` / `haiku` / `fable`) from a
 * request's model id. Used to look up the per-model 7d bucket in
 * `RateLimitSnapshot.perModel7d` during routing decisions. Returns null
 * for non-Claude models or model ids that don't carry a recognizable
 * family token (those requests just use the unified buckets).
 *
 * Generous on input shape: matches `claude-opus-4-7`, `opus`, `claude-3-7-sonnet-…`,
 * `claude-haiku-4-5`, `claude-fable-5[1m]`, anything containing the family token.
 * Lowercase-normalized so it pairs cleanly with `parseRateLimits`'s lowercase
 * family keys (the header parser is generic on `7d_<family>`, so a `7d_fable`
 * bucket is captured automatically the moment Anthropic starts emitting it —
 * this function is what lets routing USE it).
 */
export function modelFamily(modelId: string | null | undefined): string | null {
  if (!modelId) return null;
  const m = modelId.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('fable')) return 'fable';
  return null;
}

/**
 * Compute headroom for a single account given its rate-limit snapshot.
 * Headroom is the slack between the most-saturated relevant bucket and
 * full utilization: `1 - max(util5h, util7d, util_per_model_if_known)`.
 *
 * When `family` is supplied AND the snapshot has a corresponding per-
 * model 7d bucket, that bucket is included in the max. When the family
 * isn't represented in the snapshot (e.g. account hasn't seen a Sonnet
 * request yet so `7d_sonnet` is unknown), headroom is computed from the
 * unified buckets only — best-effort, populated on the next response.
 */
export function computeHeadroom(snapshot: RateLimitSnapshot, family?: string | null): number {
  const utils = [snapshot.util5h, snapshot.util7d];
  if (family) {
    const perModel = snapshot.perModel7d[family];
    if (perModel !== undefined) utils.push(perModel);
  }
  return 1 - Math.max(...utils);
}

/**
 * Session stickiness binding — ties a prioritized explicit/body/fallback
 * conversation key to one account so multi-turn agent sessions don't
 * rotate accounts mid-conversation and destroy the Anthropic prompt cache.
 *
 * Prompt cache on Claude Max is scoped to `{account × cache_control key}`.
 * A conversation that hits account A on turn 1 builds a cache entry under
 * account A. Turn 2 to account B reads nothing from A's cache and pays
 * cache-create cost again. For a long agent session that's a 5–10× token
 * cost multiplier on the cache-reused portion of every turn after the first.
 *
 * Stickiness: bind the conversation's stickyKey to an account for the life
 * of that conversation, and fall off only when the bound account is
 * exhausted / rejected. The 1-hour TTL is measured from a binding's LAST
 * use, not its creation: an actively-running session refreshes the timer on
 * every turn (see selectSticky), so it is never rebound out from under a
 * warm prompt cache — agent sessions routinely run past 1h, and an age-based
 * TTL would force such a session onto a cold account mid-conversation. A
 * conversation that goes quiet is reaped 1h after its final turn; by then
 * its cache has long expired (Anthropic prompt cache lives at most 1h) and a
 * "same" conversation returning would start fresh anyway, so rebinding is free.
 */
interface StickyBinding {
  alias: string;
  boundAt: number;    // creation time — retained for observability/debugging
  lastUsedAt: number; // last time this binding was returned; drives the idle TTL and LRU eviction
  generation: number;
}

export interface StickyLease {
  bindingKey: string;
  alias: string;
  generation: number;
}

export interface StickySelection {
  account: PoolAccount | null;
  lease: StickyLease | null;
}

export type RoutingIneligibleReason = IneligibleReason | 'plan-restricted';

export interface RoutingCandidateDiagnostic {
  alias: string;
  plan: string | null;
  requestCount: number;
  eligible: boolean;
  /** Whether the strategy can select this account now (floor-aware). */
  selectionEligible: boolean;
  reason: RoutingIneligibleReason | null;
  headroom: number;
  aboveHeadroomFloor: boolean;
  measured: boolean;
  rateLimitStatus: string;
  cooldowns: Array<{ scope: string; until: string }>;
}

export interface RoutingPoolDiagnostic {
  strategy: PoolStrategy;
  family: string | null;
  cursor: string | null;
  cursors: Record<string, string>;
  sessionAffinity: {
    enabled: boolean;
    ttlMs: number;
    bindings: number;
  };
  candidates: RoutingCandidateDiagnostic[];
}
const STICKY_IDLE_TTL_MS_DEFAULT = 60 * 60 * 1000; // default 1h; overridden by sessionAffinity.ttlMs
const STICKY_MAX_ENTRIES = 2_000;          // lazy cleanup cap
const STICKY_CLEANUP_INTERVAL_MS = 30_000; // amortize the O(n) TTL/orphan sweep

/**
 * Headroom floor under which an account is treated as "effectively exhausted"
 * for routing decisions. A sticky binding whose account drops below this
 * threshold gets rebound on the next request; the round-robin selector skips
 * accounts below this threshold when picking the next-best slot; the probe
 * loop stops once every candidate is below it. 0.02 == 2%.
 */
const POOL_HEADROOM_FLOOR = 0.02;

// Pick the account with the most headroom in a single pass. The prior
// `.reduce()` form recomputed the incumbent's headroom every iteration
// (~2n computeHeadroom calls); this computes each once (#642-audit).
function pickMaxHeadroom(accounts: PoolAccount[], family?: string | null): PoolAccount {
  let best = accounts[0];
  let bestHeadroom = computeHeadroom(best.rateLimit, family);
  for (let i = 1; i < accounts.length; i++) {
    const h = computeHeadroom(accounts[i].rateLimit, family);
    if (h > bestHeadroom) { best = accounts[i]; bestHeadroom = h; }
  }
  return best;
}

// Fill-first pick: lexicographically-first eligible account still above the
// headroom floor. Alias order (not insertion order) — accounts load from a
// readdir whose order the OS doesn't guarantee, and the operator can control
// alias names but not readdir. Returns null when every candidate is at/below
// the floor so the caller can fall back to max-headroom.
function pickFillFirst(accounts: PoolAccount[], family?: string | null): PoolAccount | null {
  let best: PoolAccount | null = null;
  for (const a of accounts) {
    if (best !== null && a.alias >= best.alias) continue;
    if (computeHeadroom(a.rateLimit, family) > POOL_HEADROOM_FLOOR) best = a;
  }
  return best;
}

/**
 * Model families that require a specific subscription plan. Accounts whose
 * `plan` field doesn't match are excluded from selection for that family.
 * Unknown plans are excluded for restricted families. Sending a Max-only
 * model to an unprobed Pro seat produces a preventable upstream rejection;
 * non-restricted families remain available while profile probing recovers.
 */
const MODEL_PLAN_REQUIREMENTS: Record<string, string> = {
  fable: 'Max',
};

/**
 * Returns true if the account is eligible for the given model family
 * based on plan requirements.
 */
function planEligible(account: PoolAccount, family: string | null | undefined): boolean {
  if (!family) return true;
  const required = MODEL_PLAN_REQUIREMENTS[family];
  if (!required) return true;
  return account.plan === required;
}

export class AccountPool {
  private accounts: Map<string, PoolAccount> = new Map();
  private queue: QueuedRequest[] = [];
  private queueMaxSize = 50;
  private queueTimeoutMs = 60_000;
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private sticky: Map<string, StickyBinding> = new Map();
  private stickySuccesses: Map<string, StickyBinding> = new Map();
  private nextStickyGeneration = 0;
  // Amortize the O(n) sticky TTL/orphan sweep — timestamp of the last run.
  private lastStickyCleanup = 0;
  // Alias most recently returned by round-robin. An alias cursor remains
  // correct when failover/exhaustion changes the candidate set; an array index
  // can point at a different account after filtering.
  private roundRobinCursors = new Map<string, string>();
  // Session affinity (sticky bindings) toggle + TTL.
  private readonly stickyEnabled: boolean;
  private readonly stickyIdleTtlMs: number;

  constructor(
    private readonly _strategy: PoolStrategy = 'headroom',
    opts?: { sessionAffinity?: boolean; sessionAffinityTtlMs?: number },
  ) {
    this.stickyEnabled = opts?.sessionAffinity ?? true;
    this.stickyIdleTtlMs = opts?.sessionAffinityTtlMs ?? STICKY_IDLE_TTL_MS_DEFAULT;
  }

  /** Current pool routing strategy. */
  get strategy(): PoolStrategy { return this._strategy; }

  add(alias: string, opts: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    deviceId: string;
    accountUuid: string;
    enabled?: boolean;
  }): void {
    const existing = this.accounts.get(alias);
    const identityChanged = existing !== undefined && (
      (existing.identity.accountUuid !== '' && opts.accountUuid !== '' && existing.identity.accountUuid !== opts.accountUuid)
      || (existing.identity.deviceId !== '' && opts.deviceId !== '' && existing.identity.deviceId !== opts.deviceId)
    );
    const preserved = identityChanged ? undefined : existing;
    if (identityChanged) this.dropStickyForAlias(alias);
    this.accounts.set(alias, {
      alias,
      accessToken: opts.accessToken,
      refreshToken: opts.refreshToken,
      expiresAt: opts.expiresAt,
      identity: preserved ? {
        deviceId: opts.deviceId || preserved.identity.deviceId,
        accountUuid: opts.accountUuid || preserved.identity.accountUuid,
        sessionId: preserved.identity.sessionId,
      } : {
        deviceId: opts.deviceId,
        accountUuid: opts.accountUuid,
        sessionId: randomUUID(),
      },
      rateLimit: preserved?.rateLimit ?? { ...EMPTY_SNAPSHOT },
      plan: preserved?.plan ?? null,
      requestCount: preserved?.requestCount ?? 0,
      enabled: opts.enabled !== false,
      refreshError: preserved?.refreshError,
      lastAuthFailureAt: preserved?.lastAuthFailureAt,
      consecutiveAuthFailures: preserved?.consecutiveAuthFailures ?? 0,
      authFailureEpoch: preserved?.authFailureEpoch ?? 0,
      rateLimitCooldowns: preserved?.rateLimitCooldowns ?? {},
      rejectionEpoch: preserved?.rejectionEpoch ?? 0,
    });
  }

  remove(alias: string): boolean {
    const removed = this.accounts.delete(alias);
    if (removed) this.dropStickyForAlias(alias);
    return removed;
  }

  get size(): number {
    return this.accounts.size;
  }

  /**
   * Record an auth failure (401/403/auth_error/permission_error/invalid_grant)
   * against `alias`. Increments the consecutive-failure counter and stamps
   * `lastAuthFailureAt`, putting the account in cool-down (see `authCooldownMs`).
   * Subsequent `select()` calls will skip this account until the cool-down
   * expires or `clearAuthFailure` is called.
   *
   * No-op if the alias isn't in the pool.
   */
  markAuthFailure(alias: string): void {
    const account = this.accounts.get(alias);
    if (!account) return;
    const now = Date.now();
    account.authFailureEpoch++;
    // Escalate the exponential cool-down only for a genuinely fresh failure.
    // A burst of concurrent in-flight requests that all 401 on the same account
    // (before the first cool-down takes hold) would otherwise bump the counter
    // k times and jump the window to authCooldownMs(k) instead of 60s
    // (#642-audit). isInAuthCooldown reflects state BEFORE this failure, so the
    // burst escalates once; always refresh the timestamp to hold the window.
    if (!isInAuthCooldown(account, now)) {
      account.consecutiveAuthFailures = (account.consecutiveAuthFailures ?? 0) + 1;
    }
    account.lastAuthFailureAt = now;
  }

  /**
   * Clear an account's auth-failure cool-down. Called by the proxy after a
   * successful upstream response on `alias` — the account is healthy again,
   * so the counter resets and any future failure starts fresh from 60s.
   *
   * Failures and successes are alias-scoped: a success on account A never
   * clears account B's cool-down.
   */
  clearAuthFailure(alias: string, observedEpoch?: number): void {
    const account = this.accounts.get(alias);
    if (!account) return;
    if (observedEpoch !== undefined && observedEpoch !== account.authFailureEpoch) return;
    if (account.consecutiveAuthFailures === 0 && !account.lastAuthFailureAt) return;
    account.lastAuthFailureAt = undefined;
    account.consecutiveAuthFailures = 0;
  }

  /**
   * Select the best account for the next request. `family` (when supplied)
   * is the request's model family (`opus` / `sonnet` / `haiku`); when
   * present and the account has a matching per-model 7d bucket, that
   * bucket joins the headroom max. Family-less calls fall back to the
   * unified-buckets-only headroom — same behavior as before this PR.
   */
  select(family?: string | null): PoolAccount | null {
    return this.selectInternal(family, true);
  }

  /** Select without consuming a round-robin turn. */
  peek(family?: string | null): PoolAccount | null {
    return this.selectInternal(family, false);
  }

  private selectInternal(family: string | null | undefined, advanceRoundRobin: boolean): PoolAccount | null {
    if (this.accounts.size === 0) return null;

    const now = Date.now();
    this.expireRateLimitCooldowns(now);
    const all = [...this.accounts.values()];

    let eligible = all.filter(a => ineligibleReason(a, now, family) === null);

    // Plan-based filtering: e.g. fable → Max only. This is a HARD gate —
    // if no eligible account has the required plan, return null rather than
    // silently routing to an account that will 403 upstream.
    if (family) {
      const planFiltered = eligible.filter(a => planEligible(a, family));
      if (planFiltered.length > 0) {
        eligible = planFiltered;
      } else if (MODEL_PLAN_REQUIREMENTS[family]) {
        return null;
      }
    }

    if (eligible.length > 0) {
      if (this._strategy === 'fill-first') {
        const first = pickFillFirst(eligible, family);
        if (first) return first;
        // Every eligible account is at/below the floor — the terminal state
        // both strategies share. Fall through to max-headroom so the caller
        // still gets the least-drained account instead of null.
      }
      if (this._strategy === 'round-robin') {
        return this.pickRoundRobin(eligible, family, advanceRoundRobin);
      }
      return pickMaxHeadroom(eligible, family);
    }

    return null;
  }

  /**
   * Select with session stickiness. If `stickyKey` is already bound to a
   * healthy account (not rejected, token not near expiry, headroom > 2%),
   * return that account. Otherwise pick by headroom (`select()`) and
   * rebind the key to the chosen account. Null key bypasses stickiness
   * and delegates to `select()`.
   *
   * Rebinding also fires when the previously-bound account is marked
   * rejected (429) or has its headroom drop below 2% — at that point the
   * conversation's cache entry on the old account is effectively stranded
   * until reset anyway, so there's no cost to moving. The new account
   * starts building its own cache for this conversation from turn 1 of
   * the rebind.
   *
   * Also performs lazy cleanup of expired bindings (TTL or size cap).
   */
  selectSticky(stickyKey: string | null, family?: string | null, now: number = Date.now()): PoolAccount | null {
    return this.selectStickyWithLease(stickyKey, family, now).account;
  }

  /** Select with affinity and return a request-scoped lease for completion. */
  selectStickyWithLease(
    stickyKey: string | null,
    family?: string | null,
    now: number = Date.now(),
  ): StickySelection {
    if (!stickyKey || !this.stickyEnabled) {
      return { account: this.select(family), lease: null };
    }
    this.cleanupSticky(now);

    const bindingKey = this.stickyBindingKey(stickyKey, family);
    const binding = this.sticky.get(bindingKey);
    if (binding) {
      const bound = this.accounts.get(binding.alias);
      if (bound
        && now - binding.lastUsedAt <= this.stickyIdleTtlMs
        && ineligibleReason(bound, now, family) === null
        && computeHeadroom(bound.rateLimit, family) > POOL_HEADROOM_FLOOR
        && planEligible(bound, family)
      ) {
        // Refresh the idle timer. A session that keeps taking turns must never
        // be reaped or rebound while active — that would strand its warm prompt
        // cache — so the TTL is re-based to now on every hit.
        binding.lastUsedAt = now;
        binding.generation = ++this.nextStickyGeneration;
        return { account: bound, lease: this.leaseFor(bindingKey, binding) };
      }
    }

    const picked = this.select(family);
    if (!picked) return { account: null, lease: null };
    const next = {
      alias: picked.alias,
      boundAt: now,
      lastUsedAt: now,
      generation: ++this.nextStickyGeneration,
    };
    this.sticky.set(bindingKey, next);
    return { account: picked, lease: this.leaseFor(bindingKey, next) };
  }

  /**
   * Rebind a sticky key to a different account — called by proxy after an
   * in-request 429 failover moves to the next-best account. Without this
   * the next turn of the same conversation would re-select the exhausted
   * account via the stale binding, eat another 429, and failover again.
   */
  rebindSticky(stickyKey: string | null, alias: string, family?: string | null): StickyLease | null {
    if (!stickyKey || !this.stickyEnabled || !this.accounts.has(alias)) return null;
    const now = Date.now();
    const bindingKey = this.stickyBindingKey(stickyKey, family);
    const next = { alias, boundAt: now, lastUsedAt: now, generation: ++this.nextStickyGeneration };
    this.sticky.set(bindingKey, next);
    return this.leaseFor(bindingKey, next);
  }

  /** Record a successful request without overwriting a newer in-flight lease. */
  confirmSticky(lease: StickyLease | null): void {
    if (!lease || !this.stickyEnabled || !this.accounts.has(lease.alias)) return;
    const now = Date.now();
    const successful = { alias: lease.alias, boundAt: now, lastUsedAt: now, generation: lease.generation };
    const previousSuccess = this.stickySuccesses.get(lease.bindingKey);
    if (!previousSuccess || previousSuccess.generation < lease.generation) {
      this.stickySuccesses.set(lease.bindingKey, successful);
    }
    const current = this.sticky.get(lease.bindingKey);
    if (!current || current.generation <= lease.generation) this.sticky.set(lease.bindingKey, successful);
  }

  /** Release only this failed request's lease, restoring the latest success. */
  releaseStickyLease(lease: StickyLease | null): void {
    if (!lease || !this.stickyEnabled) return;
    const current = this.sticky.get(lease.bindingKey);
    if (!current || current.generation !== lease.generation || current.alias !== lease.alias) return;
    const successful = this.stickySuccesses.get(lease.bindingKey);
    if (successful && this.accounts.has(successful.alias)) this.sticky.set(lease.bindingKey, { ...successful });
    else this.sticky.delete(lease.bindingKey);
  }

  /** Release a failed binding, optionally only when it still points at alias. */
  releaseSticky(stickyKey: string | null, family?: string | null, alias?: string): void {
    if (!stickyKey || !this.stickyEnabled) return;
    const key = this.stickyBindingKey(stickyKey, family);
    const binding = this.sticky.get(key);
    if (binding && (alias === undefined || binding.alias === alias)) this.sticky.delete(key);
  }

  private stickyBindingKey(stickyKey: string, family?: string | null): string {
    return `${rateLimitScope(family)}\u0000${stickyKey}`;
  }

  private leaseFor(bindingKey: string, binding: StickyBinding): StickyLease {
    return { bindingKey, alias: binding.alias, generation: binding.generation };
  }

  private dropStickyForAlias(alias: string): void {
    for (const [key, binding] of this.sticky) {
      if (binding.alias === alias) this.sticky.delete(key);
    }
    for (const [key, binding] of this.stickySuccesses) {
      if (binding.alias === alias) this.stickySuccesses.delete(key);
    }
  }

  /**
   * Drop any binding that points at an account no longer in the pool, any
   * binding past the TTL, and if we're over the size cap drop the oldest
   * entries until we're back under. O(n) but n is small (capped at 2k)
   * and this only runs on selectSticky, not on every method.
   */
  private cleanupSticky(now: number = Date.now()): void {
    // TTL/orphan sweep is O(n); amortize it — run at most once per
    // STICKY_CLEANUP_INTERVAL_MS instead of on every selectSticky (#642-audit).
    // Stale bindings are never wrongly USED meanwhile: selectSticky re-validates
    // a binding's expiry/rejection/headroom before returning it.
    if (now - this.lastStickyCleanup >= STICKY_CLEANUP_INTERVAL_MS) {
      this.lastStickyCleanup = now;
      for (const [key, b] of this.sticky) {
        // Reap orphans (account gone) and bindings idle past the TTL. Idle is
        // measured from lastUsedAt, which selectSticky refreshes every turn, so
        // an actively-running conversation is never reaped here.
        if (!this.accounts.has(b.alias) || now - b.lastUsedAt > this.stickyIdleTtlMs) {
          this.sticky.delete(key);
          this.stickySuccesses.delete(key);
        }
      }
    }
    // Hard size cap always enforced (bounds memory). Batch-evict down to 80% so
    // the O(n log n) sort amortizes over many inserts rather than firing on every
    // new conversation at the cap (#642-audit). Evict least-recently-USED first
    // (true LRU): a binding's only value is its warm prompt cache, and the ones
    // untouched longest are the coldest — least worth keeping.
    if (this.sticky.size > STICKY_MAX_ENTRIES) {
      const target = Math.floor(STICKY_MAX_ENTRIES * 0.8);
      const sorted = [...this.sticky.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
      const toDrop = sorted.slice(0, this.sticky.size - target);
      for (const [key] of toDrop) {
        this.sticky.delete(key);
        this.stickySuccesses.delete(key);
      }
    }
  }

  /** Test/inspection helper — number of live sticky bindings. */
  stickyCount(): number {
    return this.sticky.size;
  }

  /** Test/inspection helper — current alias bound to a key, or null. */
  stickyAliasFor(stickyKey: string, family?: string | null): string | null {
    return this.sticky.get(this.stickyBindingKey(stickyKey, family))?.alias ?? null;
  }

  /** Read-only router state for the local routing trace endpoint. */
  routingDiagnostic(family?: string | null, now: number = Date.now()): RoutingPoolDiagnostic {
    this.expireRateLimitCooldowns(now);
    const normalizedFamily = family?.trim().toLowerCase() || null;
    const candidates = [...this.accounts.values()]
      .sort((a, b) => a.alias.localeCompare(b.alias))
      .map((account): RoutingCandidateDiagnostic => {
        const baseReason = ineligibleReason(account, now, normalizedFamily);
        const reason: RoutingIneligibleReason | null = baseReason
          ?? (planEligible(account, normalizedFamily) ? null : 'plan-restricted');
        const headroom = computeHeadroom(account.rateLimit, normalizedFamily);
        const cooldowns = Object.entries(account.rateLimitCooldowns ?? {})
          .filter(([, cooldown]) => cooldown.until > now)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([scope, cooldown]) => ({ scope, until: new Date(cooldown.until).toISOString() }));
        return {
          alias: account.alias,
          plan: account.plan ?? null,
          requestCount: account.requestCount,
          eligible: reason === null,
          selectionEligible: false,
          reason,
          headroom: Math.max(0, Math.min(1, headroom)),
          aboveHeadroomFloor: headroom > POOL_HEADROOM_FLOOR,
          measured: account.rateLimit.measured,
          rateLimitStatus: account.rateLimit.status,
          cooldowns,
        };
      });
    const hasAboveFloor = candidates.some((candidate) => candidate.eligible && candidate.aboveHeadroomFloor);
    for (const candidate of candidates) {
      candidate.selectionEligible = candidate.eligible && (!hasAboveFloor || candidate.aboveHeadroomFloor);
    }

    return {
      strategy: this._strategy,
      family: normalizedFamily,
      cursor: this.roundRobinCursors.get(rateLimitScope(normalizedFamily)) ?? null,
      cursors: Object.fromEntries([...this.roundRobinCursors.entries()].sort(([a], [b]) => a.localeCompare(b))),
      sessionAffinity: {
        enabled: this.stickyEnabled,
        ttlMs: this.stickyIdleTtlMs,
        bindings: this.sticky.size,
      },
      candidates,
    };
  }

  /**
   * Round-robin picker: cycle through eligible accounts in stable alias order.
   * Advances the internal index so each call picks the next account, distributing
   * requests (and thus quota consumption) evenly across all healthy seats.
   * Accounts below the headroom floor are skipped — once exhausted they drop out
   * of the rotation until their window resets.
   */
  private pickRoundRobin(
    eligible: PoolAccount[],
    family?: string | null,
    advance = true,
  ): PoolAccount {
    // Filter to accounts above the headroom floor — exhausted accounts
    // drop out of rotation until their window resets. Uses per-model bucket
    // when family is known, so a sonnet-saturated account drops out of
    // rotation for sonnet requests even if its unified headroom is fine.
    const aboveFloor = eligible.filter(a => computeHeadroom(a.rateLimit, family) > POOL_HEADROOM_FLOOR);
    const candidates = aboveFloor.length > 0 ? aboveFloor : eligible;
    // Sort by alias for stable ordering regardless of Map insertion order.
    const sorted = candidates.slice().sort((a, b) => a.alias.localeCompare(b.alias));
    // Continue after the last alias and wrap. Unlike an index, this preserves
    // the sequence when an exclusion or exhausted seat shrinks the list.
    const cursorKey = rateLimitScope(family);
    const cursor = this.roundRobinCursors.get(cursorKey);
    const picked = cursor === undefined
      ? sorted[0]
      : (sorted.find((a) => a.alias.localeCompare(cursor) > 0) ?? sorted[0]);
    if (advance) this.roundRobinCursors.set(cursorKey, picked.alias);
    return picked;
  }

  /** Select the next-best account, excluding the given set of aliases. */
  selectExcluding(excluded: Set<string>, family?: string | null): PoolAccount | null {
    if (this.accounts.size <= 1) return null;

    const now = Date.now();
    this.expireRateLimitCooldowns(now);
    const candidates = [...this.accounts.values()].filter(a => !excluded.has(a.alias));

    let eligible = candidates.filter(a => ineligibleReason(a, now, family) === null);

    // Plan-based filtering: hard gate (same semantics as select()).
    if (family) {
      const planFiltered = eligible.filter(a => planEligible(a, family));
      if (planFiltered.length > 0) {
        eligible = planFiltered;
      } else if (MODEL_PLAN_REQUIREMENTS[family]) {
        return null;
      }
    }

    if (eligible.length > 0) {
      // Fill-first failover keeps the fill order: the next account tried
      // after a 429 is the next alias in line, not the max-headroom seat —
      // otherwise a single failover would defeat the concentration the
      // strategy exists to provide.
      if (this._strategy === 'fill-first') {
        const first = pickFillFirst(eligible, family);
        if (first) return first;
      }
      if (this._strategy === 'round-robin') {
        return this.pickRoundRobin(eligible, family);
      }
      return pickMaxHeadroom(eligible, family);
    }

    return null;
  }

  /**
   * Record a response against `alias`. An unmeasured snapshot (the response
   * carried no rate-limit headers — 401, 400, 5xx) counts as a request but
   * must not replace what we last measured: overwriting there reset a
   * genuinely 60%-consumed account to 0% on the first upstream error and
   * left it there until the next successful call, which is exactly the
   * window an operator is most likely to be staring at the numbers.
   */
  updateRateLimits(
    alias: string,
    snapshot: RateLimitSnapshot,
    family?: string | null,
    successful: boolean = true,
    observedRejectionEpoch?: number,
  ): void {
    const account = this.accounts.get(alias);
    if (!account) return;
    if (successful && (observedRejectionEpoch ?? account.rejectionEpoch) === account.rejectionEpoch) {
      delete account.rateLimitCooldowns[GLOBAL_RATE_LIMIT_SCOPE];
      delete account.rateLimitCooldowns[rateLimitScope(family)];
      if (!hasActiveRateLimitCooldown(account, Date.now()) && account.rateLimit.status === 'rejected') {
        account.rateLimit.status = snapshot.measured ? snapshot.status : 'unknown';
      }
    }
    // A response dispatched before a newer rejection may arrive afterwards.
    // Its headers are stale and must not overwrite the rejected snapshot even
    // when the rejection cooldown itself is correctly preserved.
    if (snapshot.measured && (observedRejectionEpoch === undefined || observedRejectionEpoch === account.rejectionEpoch)) {
      account.rateLimit = snapshot;
    }
    account.requestCount++;
  }

  /**
   * Route away from `alias` after a 429. Same rule as above for the
   * utilization figures — a 429 that arrives without rate-limit headers
   * still means "rejected", but it carries no news about the buckets, and
   * zeroing them there would make the exhausted account look like the
   * emptiest one in the pool.
   */
  markRejected(
    alias: string,
    snapshot: RateLimitSnapshot,
    family?: string | null,
    retryAfterMs?: number | null,
    now: number = Date.now(),
  ): void {
    const account = this.accounts.get(alias);
    if (!account) return;
    account.rejectionEpoch++;
    const scope = rejectionCooldownScope(snapshot, family);
    const previous = account.rateLimitCooldowns[scope];
    const inFlightBurst = Boolean(previous && previous.until > now);
    const backoffLevel = inFlightBurst ? previous!.backoffLevel : (previous?.backoffLevel ?? 0);
    const hintedDeadlines: number[] = [];
    if (Number.isFinite(retryAfterMs) && (retryAfterMs ?? 0) > 0) {
      hintedDeadlines.push(now + Math.min(Math.floor(retryAfterMs!), RATE_LIMIT_HINT_MAX_MS));
    }
    const resetAt = snapshot.reset * 1000;
    if (Number.isFinite(resetAt) && resetAt > now) {
      hintedDeadlines.push(Math.min(resetAt, now + RATE_LIMIT_HINT_MAX_MS));
    }
    const requestedUntil = hintedDeadlines.length > 0
      ? Math.max(...hintedDeadlines)
      : inFlightBurst ? previous!.until : now + rateLimitCooldownMs(backoffLevel);
    account.rateLimitCooldowns[scope] = {
      until: inFlightBurst ? Math.max(previous!.until, requestedUntil) : requestedUntil,
      backoffLevel: inFlightBurst ? backoffLevel : backoffLevel + 1,
    };
    account.rateLimit = snapshot.measured
      ? { ...snapshot, status: 'rejected' }
      : { ...account.rateLimit, status: 'rejected' };
    account.requestCount++;
  }

  private expireRateLimitCooldowns(now: number): void {
    for (const account of this.accounts.values()) {
      // Expired entries retain their backoff level until a successful response
      // clears that model scope. This lets a later 429 escalate one rung while
      // concurrent 429s inside the same window reuse its existing deadline.
      if (!hasActiveRateLimitCooldown(account, now) && account.rateLimit.status === 'rejected') {
        account.rateLimit = { ...account.rateLimit, status: 'unknown' };
      }
      // Utilization belongs to a completed quota window once its advertised
      // reset passes. Keeping the old 100% snapshot would exclude this account
      // forever because no request could reach it to collect fresh headers.
      if (account.rateLimit.reset > 0 && account.rateLimit.reset * 1000 <= now) {
        account.rateLimit = { ...EMPTY_SNAPSHOT };
      }
    }
  }

  updateTokens(alias: string, accessToken: string, refreshToken: string, expiresAt: number): void {
    const account = this.accounts.get(alias);
    if (!account) return;
    account.accessToken = accessToken;
    account.refreshToken = refreshToken;
    account.expiresAt = expiresAt;
    account.refreshError = undefined;
  }

  setRefreshError(alias: string, error: string): void {
    const account = this.accounts.get(alias);
    if (account) account.refreshError = error.slice(0, 200);
  }

  /** Update the cached plan for an account (from quota probe / profile). */
  updatePlan(alias: string, plan: string | null): void {
    const account = this.accounts.get(alias);
    if (!account) return;
    account.plan = plan;
  }

  get(alias: string): PoolAccount | undefined {
    return this.accounts.get(alias);
  }

  all(): PoolAccount[] {
    this.expireRateLimitCooldowns(Date.now());
    return [...this.accounts.values()];
  }

  status(): PoolStatus {
    const all = this.all();
    const now = Date.now();
    const healthy = all.filter(a => ineligibleReason(a, now) === null);
    // Status is a pool-wide aggregate; family-agnostic. Per-model
    // headroom is request-context-specific and only meaningful at
    // select() time.
    const headrooms = all.filter((a) => a.enabled !== false).map(a => computeHeadroom(a.rateLimit));
    const avgHeadroom = headrooms.length > 0 ? headrooms.reduce((a, b) => a + b, 0) / headrooms.length : 0;
    // Status is observational. Consuming a round-robin turn here made every
    // Accounts-tab refresh change which seat served the next real request.
    const best = this.peek();

    return {
      accounts: all.length,
      healthy: healthy.length,
      exhausted: all.length - healthy.length,
      totalHeadroom: Math.round(avgHeadroom * 100),
      bestAccount: best?.alias ?? 'none',
      queued: this.queue.length,
    };
  }

  /**
   * Wait for an available account. If all accounts are exhausted, queues
   * the request and resolves when an account becomes available via
   * updateRateLimits reducing utilization below threshold.
   */
  async waitForAccount(): Promise<PoolAccount> {
    const immediate = this.select();
    if (immediate) {
      const headroom = computeHeadroom(immediate.rateLimit);
      if (headroom > POOL_HEADROOM_FLOOR) return immediate;
    }

    if (this.queue.length >= this.queueMaxSize) {
      throw new Error('Queue full — all accounts exhausted');
    }

    if (!this.drainTimer) {
      this.drainTimer = setInterval(() => this.drainQueue(), 5_000);
      this.drainTimer.unref();
    }

    return new Promise<PoolAccount>((resolve, reject) => {
      const entry: QueuedRequest = { resolve, reject, enqueuedAt: Date.now() };
      this.queue.push(entry);

      setTimeout(() => {
        const idx = this.queue.indexOf(entry);
        if (idx >= 0) {
          this.queue.splice(idx, 1);
          reject(new Error('Queue timeout — no accounts available within 60s'));
        }
      }, this.queueTimeoutMs);
    });
  }

  private drainQueue(): void {
    if (this.queue.length === 0) {
      if (this.drainTimer) { clearInterval(this.drainTimer); this.drainTimer = null; }
      return;
    }

    const now = Date.now();
    this.queue = this.queue.filter(entry => {
      if (now - entry.enqueuedAt > this.queueTimeoutMs) {
        entry.reject(new Error('Queue timeout — no accounts available within 60s'));
        return false;
      }
      return true;
    });

    while (this.queue.length > 0) {
      const account = this.select();
      if (!account) break;
      const headroom = computeHeadroom(account.rateLimit);
      if (headroom <= POOL_HEADROOM_FLOOR) break;

      const entry = this.queue.shift();
      if (entry) entry.resolve(account);
    }

    if (this.queue.length === 0 && this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
  }
}

/** Minimal account shape the pool needs to route — a structural subset of
 *  accounts.ts' AccountCredentials, declared here to keep pool.ts dependency-free. */
export interface ReconcilableAccount {
  alias: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  deviceId: string;
  accountUuid: string;
  enabled?: boolean;
}

/**
 * Reconcile a live pool against the current on-disk account set: add or refresh
 * the tokens of every account that exists on disk, and drop any the pool still
 * holds that no longer does. `add` preserves a known alias's rate-limit and
 * identity state, so re-adding an unchanged account is a cheap token refresh
 * rather than a reset.
 *
 * This is the hot-reload primitive behind the headless admin API (#599): the
 * proxy calls it from `onAccountsChanged` so accounts provisioned or removed
 * over HTTP take effect immediately, with no proxy restart. Returns the pool
 * size after reconciliation.
 */
export function reconcilePoolAccounts(pool: AccountPool, accounts: ReconcilableAccount[]): number {
  const wanted = new Set(accounts.map(a => a.alias));
  for (const a of accounts) {
    pool.add(a.alias, {
      accessToken: a.accessToken,
      refreshToken: a.refreshToken,
      expiresAt: a.expiresAt,
      deviceId: a.deviceId,
      accountUuid: a.accountUuid,
      enabled: a.enabled,
    });
  }
  for (const existing of pool.all()) {
    if (!wanted.has(existing.alias)) pool.remove(existing.alias);
  }
  return pool.size;
}
