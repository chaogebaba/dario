/**
 * Account quota — the control-plane view of a subscription's usage windows.
 *
 * dario's other source of utilization is the `anthropic-ratelimit-unified-*`
 * headers on proxied responses (see pool.ts). Those are free but passive: they
 * only exist once traffic has flowed, they carry no per-window reset, and the
 * only per-model bucket they expose is keyed by an opaque codename. A proxy
 * that has served nothing knows nothing.
 *
 * `GET /api/oauth/usage` is what Claude Code's own UI reads, and it answers on
 * demand without spending a message: every window with its percentage, its
 * reset instant, and — for the scoped weekly window — the model's display
 * name. `GET /api/oauth/profile` supplies the plan.
 *
 * Shapes, window keys, and the Fable special-case are ported from the
 * cli-proxy-api management center (MIT), src/features/quota/providers/claude
 * and src/utils/quota/constants.ts, which is the reference implementation of
 * this card. Deviating from it silently is how you end up rendering "used"
 * where the source renders "remaining".
 */

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';

/**
 * Header set CC sends on these control-plane GETs. cli-proxy-api additionally
 * pins the wire ORDER (Accept, Content-Type, Authorization, Cache-Control,
 * User-Agent, Accept-Encoding, Host, Connection) through a uTLS transport;
 * dario reorders only its /v1/messages path today, so these go out in
 * whatever order the runtime picks. Same headers, unpinned sequence.
 */
export const QUOTA_REQUEST_HEADERS: Record<string, string> = {
  'accept': 'application/json',
  'content-type': 'application/json',
  'anthropic-beta': 'oauth-2025-04-20',
};

/**
 * Top-level usage windows, in display order.
 *
 * `iguana_necktie` is the payload's codename for the scoped weekly window —
 * the same bucket the response headers key as `7d_oi`. It is dropped when the
 * `limits[]` array carries a named Fable entry, because that entry gives the
 * model's display name and the codename does not.
 */
export const USAGE_WINDOW_KEYS: ReadonlyArray<{ key: string; id: string; label: string }> = [
  { key: 'five_hour', id: 'five-hour', label: '5-hour limit' },
  { key: 'seven_day', id: 'seven-day', label: '7-day limit' },
  { key: 'seven_day_oauth_apps', id: 'seven-day-oauth-apps', label: '7-day OAuth apps' },
  { key: 'seven_day_opus', id: 'seven-day-opus', label: '7-day Opus' },
  { key: 'seven_day_sonnet', id: 'seven-day-sonnet', label: '7-day Sonnet' },
  { key: 'seven_day_cowork', id: 'seven-day-cowork', label: '7-day Cowork' },
  { key: 'iguana_necktie', id: 'seven-day-fable', label: '7-day Fable 5' },
];

const FABLE_LABEL = '7-day Fable 5';

export interface QuotaWindow {
  id: string;
  label: string;
  /**
   * Percent of the window still available, 0-100, null when the payload
   * carried no number.
   *
   * REMAINING, not used — the reference card shows a fuel gauge, so "18%"
   * beside the 7-day row means 18% left of the week, and the bar is short and
   * red. Rendering the same number as consumption inverts every row.
   */
  remainingPercent: number | null;
  /** Epoch ms when this window resets, null when absent/unparseable. */
  resetsAt: number | null;
}

export interface ExtraUsage {
  isEnabled: boolean;
  usedCredits: number | null;
  monthlyLimit: number | null;
  currency: string | null;
}

export interface QuotaSnapshot {
  windows: QuotaWindow[];
  /** 'Max' | 'Pro' | 'Team' | 'Free', null when the profile call failed. */
  plan: string | null;
  /** Account email from profile, null when unavailable. */
  email: string | null;
  extraUsage: ExtraUsage | null;
  fetchedAt: number;
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function boolish(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(t)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(t)) return false;
  }
  return undefined;
}

/** ISO-8601 → epoch ms, null when missing or unparseable. */
export function parseResetInstant(value: unknown): number | null {
  const s = str(value);
  if (!s) return null;
  const ms = new Date(s).getTime();
  return Number.isNaN(ms) ? null : ms;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Absolute instant in the shape the reference card uses: `MM/DD, HH:mm`,
 * local, 24-hour.
 */
export function formatResetInstant(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString(undefined, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/**
 * Countdown beside the instant: `in 4 hours`, `in 2 days`, `2 hours ago`.
 *
 * Coarsest unit that still describes the gap, and truncated rather than
 * rounded — the ordinary countdown convention ("2 hours left" holds from 2:59
 * down to 2:00), and rounding up crosses unit thresholds, turning `DAY_MS - 1`
 * into "in 24 hours". For a deadline it also errs safe by never claiming more
 * time than remains. Signed, so a reset that has already passed reads "ago"
 * instead of clamping to "in 1 minute".
 */
export function formatResetRelative(targetMs: number | null, nowMs: number = Date.now()): string | null {
  if (targetMs === null || !Number.isFinite(targetMs)) return null;
  const delta = targetMs - nowMs;
  const sign = delta < 0 ? -1 : 1;
  const abs = Math.abs(delta);
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] =
    abs >= DAY_MS ? [sign * Math.floor(abs / DAY_MS), 'day']
    : abs >= HOUR_MS ? [sign * Math.floor(abs / HOUR_MS), 'hour']
    : [sign * Math.max(1, Math.floor(abs / MINUTE_MS)), 'minute'];
  try {
    return new Intl.RelativeTimeFormat(undefined, { numeric: 'always' }).format(value, unit);
  } catch {
    return `${value > 0 ? 'in ' : ''}${Math.abs(value)} ${unit}${Math.abs(value) === 1 ? '' : 's'}${value < 0 ? ' ago' : ''}`;
  }
}

/**
 * Fuel-gauge banding on REMAINING percent, matching the reference card:
 * ≥70 healthy, ≥30 warning, below that critical. Unknown is not colored —
 * an absent reading is not a low one.
 */
export function quotaBand(remainingPercent: number | null): 'high' | 'medium' | 'low' | 'unknown' {
  if (remainingPercent === null || !Number.isFinite(remainingPercent)) return 'unknown';
  if (remainingPercent >= 70) return 'high';
  if (remainingPercent >= 30) return 'medium';
  return 'low';
}

/** 100 - used, clamped, null-preserving. */
function toRemaining(used: number | null): number | null {
  if (used === null) return null;
  return Math.max(0, Math.min(100, 100 - Math.max(0, Math.min(100, used))));
}

/**
 * The scoped weekly window for Fable, when `limits[]` names one.
 *
 * Anthropic emits several `weekly_scoped` entries as more models get their own
 * bucket; match on the model's display name rather than position. An entry
 * flagged `is_active` wins — that is the one currently governing routing —
 * otherwise the first match. Entries with no percentage are skipped so a
 * placeholder can't displace a real reading.
 */
export function findFableLimit(payload: unknown): Record<string, unknown> | null {
  const limits = (payload as { limits?: unknown })?.limits;
  if (!Array.isArray(limits)) return null;
  const candidates = limits.filter((l) => {
    const kind = (str((l as Record<string, unknown>)?.['kind']) ?? '').trim().toLowerCase();
    const scope = (l as { scope?: { model?: { display_name?: unknown } } })?.scope;
    const model = (str(scope?.model?.display_name) ?? '').trim().toLowerCase();
    const isFable = model === 'fable' || model === 'fable 5';
    return kind === 'weekly_scoped' && isFable && num((l as Record<string, unknown>)?.['percent']) !== null;
  }) as Array<Record<string, unknown>>;
  return candidates.find((l) => l['is_active'] === true) ?? candidates[0] ?? null;
}

/** Normalize a `/api/oauth/usage` payload into display rows. */
export function buildQuotaWindows(payload: unknown): QuotaWindow[] {
  const out: QuotaWindow[] = [];
  if (!payload || typeof payload !== 'object') return out;
  const p = payload as Record<string, unknown>;
  const fable = findFableLimit(payload);

  for (const { key, id, label } of USAGE_WINDOW_KEYS) {
    // The named Fable entry supersedes the codename key — it is the same
    // bucket, and only one of the two can say which model it belongs to.
    if (key === 'iguana_necktie' && fable) continue;
    const w = p[key];
    if (!w || typeof w !== 'object' || !('utilization' in (w as object))) continue;
    const win = w as Record<string, unknown>;
    out.push({
      id,
      label,
      remainingPercent: toRemaining(num(win['utilization'])),
      resetsAt: parseResetInstant(win['resets_at']),
    });
  }

  if (fable) {
    const remaining = toRemaining(num(fable['percent']));
    if (remaining !== null) {
      out.push({
        id: 'seven-day-fable',
        label: FABLE_LABEL,
        remainingPercent: remaining,
        resetsAt: parseResetInstant(fable['resets_at']),
      });
    }
  }

  return out;
}

/**
 * Plan name from `/api/oauth/profile`.
 *
 * `has_claude_max` / `has_claude_pro` are the account-level flags and take
 * precedence; org type only decides Team, and only while the subscription is
 * active. Both flags explicitly false is Free — absent is unknown, which is
 * why the check is `=== false` rather than falsy.
 */
export function resolvePlan(profile: unknown): string | null {
  if (!profile || typeof profile !== 'object') return null;
  const p = profile as { account?: Record<string, unknown>; organization?: Record<string, unknown> };

  const hasMax = boolish(p.account?.['has_claude_max']);
  if (hasMax) return 'Max';
  const hasPro = boolish(p.account?.['has_claude_pro']);
  if (hasPro) return 'Pro';

  const orgType = (str(p.organization?.['organization_type']) ?? '').toLowerCase();
  const subStatus = (str(p.organization?.['subscription_status']) ?? '').toLowerCase();
  if (orgType === 'claude_team' && subStatus === 'active') return 'Team';

  if (hasMax === false && hasPro === false) return 'Free';
  return null;
}

/** Normalize the `extra_usage` block, null when absent. */
export function parseExtraUsage(payload: unknown): ExtraUsage | null {
  const raw = (payload as { extra_usage?: unknown })?.extra_usage;
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  return {
    isEnabled: boolish(e['is_enabled']) ?? false,
    usedCredits: num(e['used_credits']),
    monthlyLimit: num(e['monthly_limit']),
    currency: str(e['currency']),
  };
}

/**
 * Fetch one account's quota. The profile call is best-effort: a plan we can't
 * read is one missing line, while the windows are the whole point, so a
 * profile failure must not lose them.
 *
 * `fetchImpl` exists for tests and for callers that need a specific egress
 * route. In the proxy this runs after `installEgressProxy` has wrapped the
 * global fetch, so it follows the configured SOCKS5 egress like every other
 * upstream call — a quota probe leaking the operator's real IP would defeat
 * the point of configuring one.
 */
export async function fetchQuota(
  accessToken: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs = 10_000,
): Promise<QuotaSnapshot> {
  const headers = { ...QUOTA_REQUEST_HEADERS, authorization: `Bearer ${accessToken}` };
  const get = (url: string) =>
    fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) });

  const [usageRes, profileRes] = await Promise.allSettled([
    get(CLAUDE_USAGE_URL),
    get(CLAUDE_PROFILE_URL),
  ]);

  if (usageRes.status === 'rejected') {
    throw new Error(`usage request failed: ${usageRes.reason instanceof Error ? usageRes.reason.message : String(usageRes.reason)}`);
  }
  if (!usageRes.value.ok) {
    throw new Error(`usage request failed: HTTP ${usageRes.value.status}`);
  }
  const usage = await usageRes.value.json().catch(() => null);
  const windows = buildQuotaWindows(usage);

  let plan: string | null = null;
  let email: string | null = null;
  if (profileRes.status === 'fulfilled' && profileRes.value.ok) {
    const profileData = await profileRes.value.json().catch(() => null);
    plan = resolvePlan(profileData);
    if (profileData && typeof profileData === 'object') {
      const acct = (profileData as { account?: { email_address?: unknown } }).account;
      if (acct && typeof acct.email_address === 'string') {
        email = acct.email_address;
      }
    }
  }

  return { windows, plan, email, extraUsage: parseExtraUsage(usage), fetchedAt: Date.now() };
}

/** Fetch only the profile-derived plan used by model-family routing. */
export async function fetchPlan(
  accessToken: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs = 10_000,
): Promise<string | null> {
  const res = await fetchImpl(CLAUDE_PROFILE_URL, {
    method: 'GET',
    headers: { ...QUOTA_REQUEST_HEADERS, authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`profile request failed: HTTP ${res.status}`);
  return resolvePlan(await res.json().catch(() => null));
}
