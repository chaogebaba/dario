/**
 * /health response builder — extracted so the public-vs-internal disclosure rule
 * is unit-testable without spinning a proxy.
 *
 * dario's /health is auth-free (docker healthchecks + `depends_on: service_healthy`
 * need it before any secret is configured). When dario sits behind a Cloudflare
 * tunnel with a public /health bypass (uptime monitoring), that endpoint is
 * world-readable — so it must not leak OAuth internals (token countdown, request
 * volume, refresh errors). The Cloudflare edge stamps `cf-ray` on every request it
 * proxies, so its presence marks a request as having come from the public internet.
 * Internal callers (the docker healthcheck, `dario doctor`, the self-probe) hit
 * dario directly on loopback with no CF headers and still get the full detail.
 *
 * The HTTP status (200 healthy / 503 degraded) is identical either way, so external
 * uptime monitoring that keys on the status code is unaffected.
 */

import { blockedSummary, poolVerdict, type EligibilityFields } from './pool.js';

export interface HealthStatusLike {
  status: string;
  canRefresh?: boolean;
  expiresIn?: string;
  refreshFailures?: number;
  lastRefreshError?: string;
  /** dario's package version, surfaced to internal callers on /health (#640). */
  version?: string;
  /**
   * Live session-tracking counts, surfaced to internal callers only. Both
   * structures reap lazily (no background sweeper — see session-rotation.ts),
   * so this raw in-memory size also reveals whether lazy cleanup keeps up.
   */
  sessions?:
    | { mode: 'pool'; stickyBindings: number }
    | { mode: 'single'; active: number };
  /**
   * Request-queue snapshot (dario#905), surfaced to internal callers only.
   * `active === maxConcurrent` with `queued > 0` for a sustained period is
   * the slot-exhaustion signature — before this field existed, that state
   * was invisible from outside the process while every request 504'd.
   */
  queue?: {
    active: number;
    queued: number;
    maxConcurrent: number;
    maxQueued: number;
    /**
     * Epoch ms since the queue has been at capacity with NO slot released
     * (dario#905). Null when not at capacity; reset by any release, so
     * sustained legitimate load never accumulates age here. See
     * request-queue.ts for why turnover — not depth — is the wedge signal.
     */
    stalledSince?: number | null;
  };
  /**
   * Verdict from the opt-in serving probe (`/health?probe=1`), when the caller
   * asked for one and was trusted enough to be given it. Absent otherwise —
   * a plain /health never spends a token, so its absence means "not asked
   * for", never "failed".
   */
  probe?: ServingProbeLike;

  /**
   * Egress route + the address a remote endpoint reported (dario#987),
   * surfaced to internal callers only. This names the operator's VPN or
   * residential-proxy exit IP, which is precisely what a public /health
   * must not hand out — it belongs in the same bucket as the OAuth
   * internals, not next to the liveness verdict.
   */
  egress?: EgressLike;
}

/**
 * The subset of egress-ip.ts's snapshot that /health renders. Declared
 * structurally, like ServingProbeLike, so this module keeps no dependency
 * on the probe's network machinery.
 */
export interface EgressLike {
  /** Credential-redacted proxy URL, or null when routing direct. */
  proxy: string | null;
  scheme: string | null;
  ip: string | null;
  ok: boolean;
  checkedAt: number;
  error?: string;
  /**
   * True when the proxy answers but reports the same address an unproxied
   * request does — configured, reachable, and hiding nothing.
   */
  notChangingIp?: boolean;
}

/**
 * The subset of serving-probe.ts's ProbeResult that /health renders. Declared
 * structurally rather than imported so this module stays free of the probe's
 * network machinery and remains unit-testable as a pure function.
 */
export interface ServingProbeLike {
  ok: boolean;
  reason: string;
  checkedAt: number;
  latencyMs: number;
  model: string;
  status?: number;
  detail?: string;
}

export interface HealthResponse {
  httpStatus: number;
  body: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Pool-aware status derivation (#636)
// ---------------------------------------------------------------------------
// /status and /health must reflect what will actually happen to requests. In
// pool mode (any accounts/ entry per #618, or admin mode per #599) the legacy
// single-account getStatus() reads credentials.json — which a login-less
// pool-only setup legitimately doesn't have — so those surfaces reported
// authenticated:false / 503 "degraded" while the pool served traffic fine,
// breaking docker healthchecks and the TUI on exactly the headless deployment
// the admin API was built for. Pure function so the derivation is
// unit-testable without spinning a proxy (test/health-response.mjs).

/**
 * What this derivation needs from an account: exactly the fields the router's
 * own eligibility predicate reads. It used to be `{ expiresAt, inAuthCooldown,
 * enabled }` — the caller precomputing one clause of the predicate and this
 * function checking two of the four — so a pool of expired tokens reported
 * `healthy` while every request 503'd on `select()` returning null.
 */
export type PoolAccountStatusLike = EligibilityFields;

export interface PoolDerivedStatus {
  authenticated: boolean;
  status: 'healthy' | 'broken' | 'none';
  expiresAt?: number;
  expiresIn?: string;
  /** Distinguishes the pool-derived shape from single-account getStatus(). */
  mode: 'pool';
  accounts: number;
}

function formatMsLeft(ms: number): string {
  const clamped = Math.max(0, ms);
  return `${Math.floor(clamped / 3_600_000)}h ${Math.floor((clamped % 3_600_000) / 60_000)}m`;
}

export function derivePoolStatus(
  accounts: readonly PoolAccountStatusLike[],
  now: number,
  adminEnabled: boolean,
): PoolDerivedStatus {
  if (accounts.length === 0) {
    // Empty admin pool: 'none'/503 is CORRECT here (every LLM request 503s
    // until an account exists) — but say how to fix it instead of implying
    // `dario login`, which is exactly what an admin-mode operator avoids.
    return {
      authenticated: false,
      status: 'none',
      mode: 'pool',
      accounts: 0,
      expiresIn: adminEnabled
        ? 'no accounts yet — add one via POST /admin/login/start'
        : 'no accounts yet — run `dario accounts add <alias>`',
    };
  }
  const verdict = poolVerdict(accounts, now);
  if (verdict.state === 'blocked') {
    // Nothing the router would pick, so the next request 503s — which is the
    // deadness /health exists to signal, and the contract it advertises to the
    // uptime monitors and docker healthchecks that poll it.
    //
    // Two of these are new. An expired pool used to report `healthy` on the
    // grounds that background refresh would roll it; refresh runs every 60s
    // against a 45-minute margin, so a token that is expired *now* is one
    // refresh has already failed to roll, not one about to be rolled. An
    // all-rate-limited pool used to report `healthy` too, which was never
    // consistent with the all-auth-cooldown case reporting `broken` — both are
    // transient, both stop every request. A pool serving OpenAI-shape clients
    // through the exhausted-pool fallback is the one case this calls dead
    // while something still gets through; Anthropic-shape requests, which are
    // the reason dario exists, still 503.
    return {
      authenticated: false,
      status: 'broken',
      mode: 'pool',
      accounts: verdict.accounts,
      expiresAt: verdict.expiresAt,
      expiresIn: blockedSummary(verdict),
    };
  }
  // Earliest expiry among the accounts that can serve — a dead seat beside a
  // live one must not drag the reported figure down.
  return {
    authenticated: true,
    status: 'healthy',
    mode: 'pool',
    accounts: verdict.accounts,
    expiresAt: verdict.expiresAt,
    expiresIn: formatMsLeft(verdict.expiresAt - now),
  };
}

/**
 * Render `stalledSince` as an elapsed duration alongside the raw stamp. The
 * stamp alone forces every consumer to subtract against its own clock, which
 * is exactly the arithmetic a shell-based healthcheck can't do — and #905's
 * reporter was writing his monitor in bash.
 */
function withStalledFor(
  q: NonNullable<HealthStatusLike['queue']>,
  now: number,
): Record<string, unknown> {
  const { stalledSince, ...rest } = q;
  if (stalledSince === null || stalledSince === undefined) return { ...rest, stalledSince: null };
  return { ...rest, stalledSince, stalledForMs: Math.max(0, now - stalledSince) };
}

export function buildHealthResponse(
  s: HealthStatusLike,
  requestCount: number,
  includeInternal: boolean,
  now: number = Date.now(),
): HealthResponse {
  const structurallyDead =
    s.status === 'broken' ||
    s.status === 'none' ||
    (s.status === 'expired' && s.canRefresh === false);
  // A failed round-trip is authoritative over a clean structural read: the
  // whole point of the probe (dario#905) is the state where local inspection
  // says healthy and every real request fails. When one was run and it came
  // back false, /health must say degraded — that is what makes an existing
  // status-code-only uptime monitor start seeing the outage it used to miss.
  const dead = structurallyDead || s.probe?.ok === false;
  const httpStatus = dead ? 503 : 200;
  const liveness = { status: dead ? 'degraded' : 'ok' };
  // Only trusted callers (authenticated, or bare loopback not via the CF
  // tunnel — see shouldDiscloseHealthInternals) get the OAuth internals.
  // Everyone else (LAN, public tunnel) gets the liveness verdict only; the
  // HTTP status is identical either way so uptime checks still work. #642:
  // this used to key on the presence of the client-suppliable `cf-ray`
  // header, which failed OPEN — a direct non-tunnel caller omits it and got
  // the full internal view. `lastRefreshError` is no longer exposed here at
  // all (it can carry a raw upstream error string); it remains on the
  // key-gated /status.
  const body: Record<string, unknown> = includeInternal
    ? {
        ...liveness,
        ...(s.version ? { version: s.version } : {}),
        oauth: s.status,
        expiresIn: s.expiresIn,
        requests: requestCount,
        ...(s.sessions ? { sessions: s.sessions } : {}),
        ...(s.queue ? { queue: withStalledFor(s.queue, now) } : {}),
        ...(s.probe ? { probe: { ...s.probe, ageMs: Math.max(0, now - s.probe.checkedAt) } } : {}),
        ...(s.egress ? { egress: { ...s.egress, ageMs: Math.max(0, now - s.egress.checkedAt) } } : {}),
        ...(s.refreshFailures ? { refreshFailures: s.refreshFailures } : {}),
      }
    : liveness;
  return { httpStatus, body };
}

/**
 * Did this caller ask for a serving probe? (`/health?probe=1`, dario#905.)
 *
 * Accepts `probe=1` / `probe=true` / bare `probe`, rejects `probe=0` and
 * `probe=false` — a monitor templating the flag from a boolean config should
 * get the behaviour it wrote, not a probe on every poll because the parameter
 * was merely present. Anything unparseable is treated as "not asked": the
 * failure direction for a token-spending flag has to be off.
 */
export function probeRequested(url: string | undefined): boolean {
  const q = url?.indexOf('?') ?? -1;
  if (q < 0) return false;
  const v = new URLSearchParams(url!.slice(q + 1)).get('probe');
  if (v === null) return false;
  if (v === '') return true; // bare `?probe`
  return v === '1' || v.toLowerCase() === 'true';
}

/**
 * Decide whether to actually RUN a serving probe for this caller (dario#905).
 *
 * Deliberately stricter than shouldDiscloseHealthInternals, because this is
 * not a disclosure decision — it spends the operator's money.
 *
 * The disclosure gate grants access to a caller that proved a configured
 * DARIO_API_KEY, wherever it came from. That is the right answer for reading a
 * field. It is not the right answer for an action that bills per call: a
 * leaked or shared key becomes a metered spend endpoint reachable from the
 * public internet, and the probe's own cache means an attacker needs only one
 * request per TTL to keep it running indefinitely.
 *
 * So the probe additionally refuses anything that arrived through the tunnel,
 * whatever the disclosure gate concluded. This only ever DENIES — it cannot
 * widen access.
 *
 * (An unkeyed proxy is handled a layer up: shouldDiscloseHealthInternals now
 * requires `keyConfigured`, so vacuous authentication no longer reaches here
 * at all. This gate does not depend on that fix — it would refuse the tunnel
 * caller either way — but the two are the same defence at different depths.)
 *
 * Accepted trade-off: an operator who authenticates THROUGH the tunnel is also
 * refused, and has to probe from beside the proxy instead. For a flag whose
 * failure direction is "silently spends money", off is the right default.
 */
export function shouldRunServingProbe(opts: {
  requested: boolean;
  discloseInternals: boolean;
  viaCfRay: boolean;
}): boolean {
  if (!opts.requested) return false;
  if (opts.viaCfRay) return false;
  return opts.discloseInternals;
}

/**
 * Decide whether a /health caller may see the OAuth internals (#642).
 *
 * /health is intentionally auth-free (docker healthchecks need it before a
 * key is configured), so we cannot simply gate on the API key. Trust model:
 *   - PROVED a configured DARIO_API_KEY        -> internal (an internal caller)
 *   - came via the Cloudflare tunnel (cf-ray)  -> public   (world-reachable)
 *   - otherwise bare loopback                  -> internal (docker HC / doctor)
 *   - otherwise (LAN, other container, WAN)    -> public
 * The cf-ray check is only ever used to DENY (force public), never to grant,
 * so spoofing it cannot widen disclosure.
 *
 * `keyConfigured` is load-bearing and is why `authenticated` alone is not
 * enough. `authenticateRequest()` short-circuits to TRUE when no
 * DARIO_API_KEY is set — a deliberate convenience, since the common setup is
 * loopback-only and requiring a key there would break `dario doctor` and every
 * docker healthcheck. But it means "authenticated" is VACUOUS on an unkeyed
 * proxy: every caller satisfies it, the first branch returns before cf-ray is
 * ever consulted, and an unkeyed dario published through a Cloudflare tunnel
 * hands its OAuth countdown, request volume and refresh-failure count to
 * anyone who asks. That is the #642 fail-open re-entering through a side door
 * — #642 closed the spoofable-header direction, not this one.
 *
 * Requiring both means the auth branch can only be taken by a caller that
 * actually presented the operator's secret. Unkeyed proxies fall through to
 * the transport rules, where loopback is still trusted (healthchecks and
 * doctor keep working, unchanged) and the tunnel is not.
 *
 * `keyConfigured` is a REQUIRED field rather than an optional with a default:
 * for a security predicate, every call site should be forced to state it.
 *
 * The HTTP status (200/503) is unaffected either way, so uptime monitoring
 * that keys on the status code sees no change from this.
 */
export function shouldDiscloseHealthInternals(opts: {
  /** Passed authenticateRequest — which is vacuously true when unkeyed. */
  authenticated: boolean;
  /** Whether a DARIO_API_KEY exists at all, i.e. whether `authenticated` means anything. */
  keyConfigured: boolean;
  loopback: boolean;
  viaCfRay: boolean;
}): boolean {
  if (opts.authenticated && opts.keyConfigured) return true;
  if (opts.viaCfRay) return false;
  return opts.loopback;
}
