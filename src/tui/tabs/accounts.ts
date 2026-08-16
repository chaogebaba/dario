/**
 * Accounts tab — list of OAuth subscription accounts in the pool.
 *
 * Source of truth is the RUNNING PROXY's live pool (`GET /accounts`), not a
 * local disk read: the TUI is its own process, and in a containerized / admin
 * (#599) / login-less-pool (#630) deployment the accounts live in the proxy's
 * volume, so reading `~/.dario/accounts/` in the TUI process comes up empty
 * while the proxy serves several accounts fine (#641). We fall back to the disk
 * read only when the proxy is unreachable, and flag it so the user knows the
 * view may be stale.
 *
 * Read-mostly. Mutations (add/remove) require the CLI or the admin API — the
 * tab shows the relevant command in the footer.
 *
 * Layout:
 *
 *   ┌─ Accounts ──────────────────────────────────────┐
 *   │  alias            expires    util5h   util7d    │
 *   │  ─────            ───────    ──────   ──────    │
 *   │  default          7h 41m       12%      4%      │
 *   │  alt              expired       0%      0%      │
 *   │  …                                              │
 *   └─────────────────────────────────────────────────┘
 *   To add: `dario accounts add <alias>`
 *   To remove: `dario accounts remove <alias>`
 */

import type { Tab, TabContext } from '../tab.js';
import { fg, dim, bold, brand, pad, truncate, progressBar } from '../render.js';
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
    /**
     * When the utilization figures were last measured, 0/undefined when
     * never. dario only sees utilization on responses it proxies, so a
     * proxy that has served nothing reports `util5h: 0` meaning "no idea",
     * and rendering that as `0%` tells the operator their quota is
     * untouched. Unmeasured renders `—`.
     */
    measuredAt?: number;
    /**
     * Control-plane quota from `GET /quota`. Preferred over the header-derived
     * util columns above: it exists without traffic, carries a per-window
     * reset, and names the per-model bucket. Absent when the proxy predates
     * the endpoint or the fetch failed — the util table is the fallback.
     */
    quota?: AccountQuota;
  }>;
  error: string | null;
  /** Where the list came from: the running proxy's pool, the proxy's
   *  single-account mode, or a local disk fallback when the proxy is down. */
  source?: 'pool' | 'single-account' | 'disk';
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
    return { loading: true, accounts: [], error: null };
  },

  async onMount(_state, ctx: TabContext): Promise<AccountsState | undefined> {
    return refreshAccounts(ctx);
  },

  onKey(state, key) {
    if (key.name === 'printable' && key.ch === 'r' && !key.ctrl) {
      // `forceQuota` rides along so the refetch bypasses the proxy's 60s
      // quota cache. An explicit keypress asking for a refresh and getting a
      // cached answer is the one case the cache must not win.
      forceQuota = true;
      return { ...state, loading: true };
    }
    return undefined;
  },

  onTick(state, ctx) {
    // onKey can only return new state, not run async work — so a manual
    // refresh ('r') just sets loading:true and this tick drives the refetch.
    // `refreshInFlight` guards against the 250ms tick stacking overlapping
    // fetches while one is already running.
    if (state.loading && !refreshInFlight) {
      refreshInFlight = true;
      const force = forceQuota;
      forceQuota = false;
      void refreshAccounts(ctx, force)
        .then((next) => ctx.setState(next))
        .finally(() => { refreshInFlight = false; });
    }
  },

  render(state, dimv): string {
    const lines: string[] = [];
    const w = dimv.cols;
    // Bound every row at the push site rather than at each call site. The
    // column header (68 wide) and the disk-fallback path (which
    // interpolates `~/.dario/accounts/<alias>.json`, unbounded by alias
    // length) both overflowed; hand-auditing 15 separate pushes is how
    // that got missed.
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
        push('  ' + 'Start a pool: ' + fg('cyan', 'dario accounts add <alias>'));
      } else {
        push('  ' + dim('No accounts in the pool.'));
        push('  ' + 'Add one: ' + fg('cyan', 'dario accounts add <alias>'));
      }
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

    push('');
    push(' ' + dim('Mutations via CLI:'));
    push('   ' + fg('cyan', 'dario accounts add <alias>'));
    push('   ' + fg('cyan', 'dario accounts remove <alias>'));

    // Refresh hint
    push('');
    push(' ' + renderKvRow('', '', w - 2));   // spacer
    push(' ' + dim(`Press ${fg('cyan', 'r')} to refresh quota.`));

    return lines.join('\n');
  },
};

/**
 * The quota card, mirroring the cli-proxy-api management-center layout: an
 * account header carrying the plan, then one row per usage window showing the
 * percentage REMAINING, its reset instant with a countdown, and a meter.
 *
 * Every number here is remaining, not consumed — see QuotaWindow. The meter
 * reads as a fuel gauge: full and green is good.
 */
function renderQuotaCards(
  state: AccountsState,
  push: (s: string) => void,
  w: number,
): void {
  const now = Date.now();
  // Label column sized to the widest label present so the percentages line up
  // across windows and across accounts.
  const labelWidth = Math.max(
    14,
    ...state.accounts.flatMap((a) => (a.quota?.windows ?? []).map((win) => win.label.length)),
  );
  const barWidth = Math.max(8, Math.min(w - 8, 56));

  for (const acc of state.accounts) {
    push('');
    const expiry = formatExpiry(acc.expiresAt);
    const planPart = acc.quota?.plan ? dim('Plan ') + bold(acc.quota.plan) : '';
    push('  ' + fg('cyan', '●') + ' ' + bold(acc.alias) + '  ' + dim('token ') + expiry
      + (planPart ? '   ' + planPart : ''));

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

/** Colored meter over the REMAINING fraction. Unknown renders an empty track. */
function meter(remainingPercent: number | null, width: number): string {
  const band = quotaBand(remainingPercent);
  const bar = progressBar((remainingPercent ?? 0) / 100, width);
  if (band === 'unknown') return dim(bar);
  const color = band === 'high' ? 'green' : band === 'medium' ? 'yellow' : 'red';
  // Color only the filled run; the empty track stays dim so a nearly-drained
  // window reads as a short colored stub rather than a full-width red line.
  const cells = Math.round(Math.max(0, Math.min(1, (remainingPercent ?? 0) / 100)) * width);
  return fg(color, bar.slice(0, cells)) + dim(bar.slice(cells));
}

/**
 * Pre-/quota fallback: the header-derived utilization table. Retained because
 * a proxy older than the endpoint still reports util5h/util7d on /accounts,
 * and because a failed control-plane fetch should degrade rather than blank.
 */
function renderUtilTable(
  state: AccountsState,
  push: (s: string) => void,
  w: number,
): void {
  // Live pool data (from /accounts) carries utilization; the disk fallback
  // doesn't, so show the util columns only when the pool populated them.
  const hasUtil = state.accounts.some((a) => a.util5h !== undefined);

  // Header row
  push('  ' + dim(
    hasUtil
      ? pad('alias', 20) + pad('expires', 14) + pad('util5h', 9) + pad('util7d', 9) + pad('status', 14)
      : pad('alias', 20) + pad('expires', 16) + pad('source', 24)
  ));
  push('  ' + dim('─'.repeat(Math.min(w - 4, 66))));

  for (const acc of state.accounts) {
    const aliasCol = pad(acc.alias, 20);
    if (hasUtil) {
      const expiresCol = pad(formatExpiry(acc.expiresAt), 14);
      // `—` when the pool has never seen a response for this account.
      // Printing the placeholder 0 as `0%` is the whole bug this column
      // had: it reads as a measurement of an untouched quota.
      const seen = isMeasured(acc);
      const u5 = pad(seen ? `${Math.round((acc.util5h ?? 0) * 100)}%` : '—', 9);
      const u7 = pad(seen ? `${Math.round((acc.util7d ?? 0) * 100)}%` : '—', 9);
      const statusCol = acc.status ?? '—';
      const statusFg = statusCol === 'auth-cooldown' ? fg('yellow', statusCol) : dim(statusCol);
      push('  ' + aliasCol + expiresCol + u5 + u7 + statusFg);
    } else {
      const expiresCol = pad(formatExpiry(acc.expiresAt), 16);
      const sourceCol = '~/.dario/accounts/' + acc.alias + '.json';
      push('  ' + aliasCol + expiresCol + dim(sourceCol));
    }
  }

  // Without this the `—` column is a mystery. dario reads utilization off
  // the rate-limit headers of responses it proxies and nowhere else, so an
  // idle proxy genuinely has nothing to show — say so rather than let the
  // operator conclude the feature is broken.
  if (hasUtil && !state.accounts.some(isMeasured)) {
    push('');
    push('  ' + dim('util is read from proxied responses — none seen yet this run.'));
    push('  ' + dim('For a reading now: ') + fg('cyan', 'dario doctor --usage'));
  }
}

/** Guards the onTick refetch against overlapping in-flight fetches. */
let refreshInFlight = false;

/** Set by the `r` keypress so the next refetch bypasses the quota cache. */
let forceQuota = false;

/**
 * Has this account's utilization actually been measured? A proxy older than
 * `measuredAt` omits the field entirely; fall back to the pre-existing
 * "util present" test there so an old proxy behaves as it did before rather
 * than blanking every column.
 */
function isMeasured(acc: AccountsState['accounts'][number]): boolean {
  if (acc.measuredAt !== undefined) return acc.measuredAt > 0;
  return acc.util5h !== undefined;
}

/** Shape of the proxy's `GET /quota` response (see src/proxy.ts). */
interface QuotaEndpoint {
  accounts?: Array<{ alias: string; windows?: QuotaWindow[]; plan?: string | null; error?: string }>;
}

/**
 * Control-plane quota for every account, keyed by alias.
 *
 * Best-effort by design: `/quota` reaches out to Anthropic, so it is slower
 * and more failure-prone than the local `/accounts` read, and a proxy older
 * than the endpoint 404s. Either way the account list still renders — the
 * util table is the fallback view.
 */
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
  } catch {
    // Endpoint missing or unreachable — render without it.
  }
  return out;
}

export async function refreshAccounts(
  ctx?: TabContext<AccountsState>,
  forceQuotaRefresh = false,
): Promise<AccountsState> {
  // Preferred source: the running proxy's live pool. This is what actually
  // serves traffic, and it works regardless of which process/host/volume the
  // TUI itself runs on — the fix for #641, where a containerized proxy held
  // the accounts and the TUI's local disk read came up empty.
  if (ctx) {
    try {
      const r = await ctx.client.getJson<AccountsEndpoint>('/accounts');
      if (r.mode === 'single-account') {
        return { loading: false, accounts: [], error: null, source: 'single-account' };
      }
      if (Array.isArray(r.accounts)) {
        const now = Date.now();
        const quota = await fetchQuotaMap(ctx, forceQuotaRefresh);
        return {
          loading: false,
          source: 'pool',
          accounts: r.accounts.map((a) => ({
            alias: a.alias,
            // Prefer the absolute timestamp: `expiresInMs` is clamped at 0
            // upstream, which renders a long-dead token as `0m` instead of
            // `expired`. Older proxies send only the clamped remainder.
            expiresAt: a.expiresAt ?? now + (a.expiresInMs ?? 0),
            util5h: a.util5h,
            util7d: a.util7d,
            status: a.status,
            measuredAt: a.measuredAt,
            ...(quota.has(a.alias) ? { quota: quota.get(a.alias)! } : {}),
          })),
          error: null,
        };
      }
      // Unknown shape — fall through to the disk read below.
    } catch {
      // Proxy unreachable (not running, wrong port, missing key) — fall back
      // to the on-disk view so a standalone TUI still shows something, flagged
      // stale so the user knows it isn't the live pool.
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
      return { loading: false, accounts: [], error: null, source: 'disk' };
    }
    const all = await loadAllAccounts();
    return {
      loading: false,
      source: 'disk',
      accounts: all.map((a) => ({ alias: a.alias, expiresAt: a.expiresAt })),
      error: null,
    };
  } catch (e) {
    return { loading: false, accounts: [], error: (e as Error).message, source: 'disk' };
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
