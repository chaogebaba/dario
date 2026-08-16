#!/usr/bin/env bun
// Tests for the six v4 tabs — pure-render assertions on each.
//
// Every tab's render(state, dim) is a pure function, so this exercises
// state→ANSI conversion without needing a real TTY. The TuiApp's
// integration (key routing, lifecycle, async data) needs a TTY and
// is covered by manual smoke tests + M5+M6 e2e.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The Config tab's save path is real: `doSave` calls `saveConfig` with no
// path, which resolves to `$HOME/.dario/config.json`. Exercising the save
// key therefore rewrites the operator's actual config — verified, not
// theorised. It round-trips cleanly today, so nothing has been lost, but
// a unit test is one schema change away from silently dropping a field
// from real user state.
//
// `DEFAULT_CONFIG_PATH` is a module-level const, frozen the moment
// config-file.js is first evaluated, and ESM hoists static imports above
// all statements. So HOME has to be redirected before the dist modules
// are pulled in, which means importing them dynamically here.
process.env.HOME = mkdtempSync(join(tmpdir(), 'dario-tui-home-'));

const { StatusTab } = await import('../dist/tui/tabs/status.js');
const { ConfigTab } = await import('../dist/tui/tabs/config.js');
const { AnalyticsTab } = await import('../dist/tui/tabs/analytics.js');
const { HitsTab } = await import('../dist/tui/tabs/hits.js');
const { AccountsTab } = await import('../dist/tui/tabs/accounts.js');
const { BackendsTab } = await import('../dist/tui/tabs/backends.js');
const { visibleWidth, truncate, dim, inverse, pad } = await import('../dist/tui/render.js');
const { renderFooter } = await import('../dist/tui/layout.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  OK ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
}
function header(n) { console.log(`\n=== ${n} ===`); }

const DIM = { cols: 80, rows: 24 };

// ─────────────────────────────────────────────────────────────
header('Tab metadata — every tab has the expected shape');
for (const [name, tab] of [
  ['Status', StatusTab], ['Config', ConfigTab], ['Analytics', AnalyticsTab],
  ['Hits', HitsTab], ['Accounts', AccountsTab], ['Backends', BackendsTab],
]) {
  check(`${name}: id is non-empty`,    typeof tab.id === 'string' && tab.id.length > 0);
  check(`${name}: label is non-empty`, typeof tab.label === 'string' && tab.label.length > 0);
  check(`${name}: initialState fn`,    typeof tab.initialState === 'function');
  check(`${name}: render fn`,          typeof tab.render === 'function');
}

// ─────────────────────────────────────────────────────────────
// dario#986 — the parent router (tui-app.ts onKey) matches tab hotkeys
// BEFORE delegating to the active tab's onKey. Any tab hotkey that
// equals a key the Config tab handles in normal mode is therefore dead
// on arrival: pressing it jumps tabs instead of doing the local action.
// `s` (save) regressed exactly this way — Status owned lowercase `s`,
// so config changes could never be written from the TUI.
header('Tab hotkeys never shadow Config normal-mode keys');
{
  const TABS = [StatusTab, ConfigTab, AnalyticsTab, HitsTab, AccountsTab, BackendsTab];
  const hotkeys = TABS.map(t => t.hotkey).filter(k => typeof k === 'string');

  // Keys ConfigTab.onKey consumes in normal mode (editBuffer === null).
  // Kept in sync with src/tui/tabs/config.ts and the in-panel help line.
  const CONFIG_LOCAL_KEYS = ['s', 'd', 'r'];

  for (const k of CONFIG_LOCAL_KEYS) {
    const owner = TABS.find(t => t.hotkey === k);
    check(
      `Config '${k}' is not shadowed by a tab hotkey`,
      owner === undefined,
      owner ? `${owner.label} claims '${k}'` : undefined,
    );
  }

  // Hotkeys must also be unique, or the earlier tab wins silently.
  check('all tab hotkeys are distinct', new Set(hotkeys).size === hotkeys.length,
    hotkeys.join(','));

  // Prove the save path actually reaches ConfigTab.onKey for 's'.
  //
  // `afterSave !== undefined` is not that proof: doSave catches its own
  // errors and returns a populated state on failure, so a save that threw
  // passed — and so did rewiring 's' to doDiscard. The regression this
  // guards (dario 7a977ae, Status swallowing Config's save key) is only
  // caught by asserting the save actually succeeded. HOME is sandboxed
  // above, so this writes to a temp dir rather than the operator's config.
  const cfg = ConfigTab.initialState();
  const afterSave = ConfigTab.onKey(cfg, { name: 'printable', ch: 's', ctrl: false });
  check('ConfigTab.onKey handles lowercase s', afterSave !== undefined);
  check("'s' reaches doSave and the save succeeds",
    afterSave?.statusKind === 'success', `${afterSave?.statusKind}: ${afterSave?.statusMessage}`);
  check("'s' is save, not discard",
    /saved/i.test(afterSave?.statusMessage ?? ''), afterSave?.statusMessage);
}

// ─────────────────────────────────────────────────────────────
header('Status tab — loading + reachable + unreachable');
{
  const initial = StatusTab.initialState();
  const r1 = StatusTab.render(initial, DIM);
  check('initial render contains "Loading"', r1.includes('Loading'));

  // Mock reachable proxy
  const reachable = {
    ...initial,
    loading: false,
    health: { status: 'ok', oauth: 'healthy', expiresIn: '7h 41m', requests: 42 },
    configSource: 'file',
    lastRefreshAt: Date.now(),
  };
  const r2 = StatusTab.render(reachable, DIM);
  check('reachable: shows healthy',           r2.includes('healthy'));
  check('reachable: shows expiry',            r2.includes('7h 41m'));
  check('reachable: shows requests',          r2.includes('42'));
  check('reachable: shows config path',       r2.includes('config.json'));
  // No egress proxy configured → /health carries no egress row, and the
  // tab must not invent one. A row reading "direct" on a direct setup is
  // noise; its absence is the signal.
  check('no egress row when none is configured', !r2.includes('Egress'));

  // Egress row (dario#987) — the address is the only thing that proves
  // the proxy is carrying traffic rather than forwarding from this host.
  const withEgress = {
    ...reachable,
    health: {
      ...reachable.health,
      egress: {
        proxy: 'socks5h://***:***@vpn.example:1080',
        scheme: 'socks5h',
        ip: '185.244.213.7',
        ok: true,
        checkedAt: Date.now() - 30_000,
      },
    },
  };
  const rEgress = StatusTab.render(withEgress, DIM);
  check('egress: shows the address Anthropic sees', rEgress.includes('185.244.213.7'));
  check('egress: shows the route',                  rEgress.includes('vpn.example:1080'));
  check('egress: never renders credentials',        !rEgress.includes('hunter2') && rEgress.includes('***'));

  const brokenEgress = {
    ...withEgress,
    health: {
      ...withEgress.health,
      egress: { ...withEgress.health.egress, ok: false, ip: null, error: 'could not reach https://x — ECONNREFUSED' },
    },
  };
  const rEgressBad = StatusTab.render(brokenEgress, DIM);
  check('broken egress: says the check is failing', rEgressBad.includes('egress check failing'));
  check('broken egress: shows the reason',          rEgressBad.includes('ECONNREFUSED'));
  check('broken egress: does not show a stale IP',  !rEgressBad.includes('185.244.213.7'));

  // The proxy is up, the check passes, and the address is the one an
  // unproxied request gets — a route that looks healthy in every other
  // row while hiding nothing. It has to read as a failure, not a pass.
  const uselessEgress = {
    ...withEgress,
    health: {
      ...withEgress.health,
      egress: { ...withEgress.health.egress, notChangingIp: true },
    },
  };
  const rUseless = StatusTab.render(uselessEgress, DIM);
  check('unproxied egress: still shows the address', rUseless.includes('185.244.213.7'));
  check('unproxied egress: flags it as unproxied',   /same as unproxied/.test(rUseless));
  check('unproxied egress: explains the cause',      /forwarding from this host/.test(rUseless));

  // Mock unreachable proxy
  const unreachable = {
    ...initial,
    loading: false,
    health: null,
    configSource: 'missing',
    error: 'ECONNREFUSED',
  };
  const r3 = StatusTab.render(unreachable, DIM);
  check('unreachable: shows error UI',        r3.includes('unreachable'));
  check('unreachable: shows config defaults', r3.includes('defaults'));

  // Models panel — advertised catalog from /v1/models, [1m] folded onto base
  const withModels = {
    ...reachable,
    models: ['claude-fable-5', 'claude-fable-5[1m]', 'claude-opus-4-8', 'claude-opus-4-8[1m]', 'claude-sonnet-5', 'claude-sonnet-5[1m]', 'claude-haiku-4-5'],
  };
  const r4 = StatusTab.render(withModels, DIM);
  check('models: shows Models header',        r4.includes('Models'));
  check('models: shows fable-5',              r4.includes('claude-fable-5'));
  check('models: shows sonnet-5',             r4.includes('claude-sonnet-5'));
  check('models: folds [1m] onto base',       r4.includes('+[1m]') && !r4.includes('claude-fable-5[1m]'));
  check('models: null models → no panel (r2)', !r2.includes('Models'));
}

// ─────────────────────────────────────────────────────────────
header('Status tab — foldLongContextVariants');
{
  const { foldLongContextVariants } = await import('../dist/tui/tabs/status.js');
  const folded = foldLongContextVariants(['claude-fable-5', 'claude-fable-5[1m]', 'claude-haiku-4-5']);
  check('fold: pairs collapse to one row', folded.length === 2);
  check('fold: paired base marked has1m', folded[0].base === 'claude-fable-5' && folded[0].has1m === true);
  check('fold: unpaired base not marked', folded[1].base === 'claude-haiku-4-5' && folded[1].has1m === false);
  const orphan = foldLongContextVariants(['claude-opus-4-8[1m]']);
  check('fold: orphan [1m] keeps a row under its base id', orphan.length === 1 && orphan[0].base === 'claude-opus-4-8' && orphan[0].has1m === true);
  check('fold: order preserved', foldLongContextVariants(['b', 'a'])[0].base === 'b');
}

// ─────────────────────────────────────────────────────────────
header('Config tab — read + dirty + edit states');
{
  const initial = ConfigTab.initialState();
  const r1 = ConfigTab.render(initial, DIM);
  check('initial: shows Port label',       r1.includes('Port'));
  check('initial: shows stealth row',      r1.includes('Stealth preset'));
  check('initial: no unsaved marker',      !r1.includes('unsaved changes'));

  // Simulate a key edit — start editing Port (selected idx 0 is Port)
  const editing = ConfigTab.onKey(initial, { name: 'enter', ch: '', ctrl: false, shift: false, meta: false });
  // Port is a number field; Enter opens edit buffer with current value
  check('Enter starts edit',               editing && editing.editBuffer !== null);
  const r2 = ConfigTab.render(editing, DIM);
  check('edit mode shows prompt',          r2.includes('Edit Port'));

  // Type a new value. startEdit pre-fills with the current value
  // (Port = 3456), so we backspace-clear before typing the new digits.
  let s = editing;
  for (let i = 0; i < 6; i++) {  // overshoot — extra backspaces are no-ops on empty
    s = ConfigTab.onKey(s, { name: 'backspace', ch: '', ctrl: false, shift: false, meta: false });
  }
  check('backspace clears buffer',         s.editBuffer === '');
  for (const ch of '9876') {
    s = ConfigTab.onKey(s, { name: 'printable', ch, ctrl: false, shift: false, meta: false });
  }
  check('typed digits accumulate',         s.editBuffer === '9876');

  // Confirm with Enter
  s = ConfigTab.onKey(s, { name: 'enter', ch: '', ctrl: false, shift: false, meta: false });
  check('after commit: port is 9876',      s.config.port === 9876);
  check('after commit: edit buffer null',  s.editBuffer === null);
  check('after commit: dirty marker',      ConfigTab.render(s, DIM).includes('unsaved'));

  // Discard
  const discarded = ConfigTab.onKey(s, { name: 'printable', ch: 'd', ctrl: false, shift: false, meta: false });
  check('discard restores snapshot',       JSON.stringify(discarded.config) === JSON.stringify(discarded.snapshot));
}

// ─────────────────────────────────────────────────────────────
header('Config tab — prototype-pollution defence');
{
  // setByPath isn't exported, but exercising every legitimate field
  // through the full edit cycle should never touch Object.prototype.
  // This pins the contract: the tab's state machine, when driven via
  // its public API, never pollutes the global prototype chain even
  // under hostile key sequences.
  const beforeToString = Object.prototype.toString;
  const beforeHasOwn = Object.prototype.hasOwnProperty;
  let s = ConfigTab.initialState();
  for (let i = 0; i < 14; i++) {  // overshoot — extra Down arrows clamp at the last field
    s = ConfigTab.onKey(s, { name: 'enter', ch: '', ctrl: false, shift: false, meta: false });
    if (s.editBuffer !== null) {
      s = ConfigTab.onKey(s, { name: 'enter', ch: '', ctrl: false, shift: false, meta: false });
    }
    s = ConfigTab.onKey(s, { name: 'down', ch: '', ctrl: false, shift: false, meta: false });
  }
  check('Object.prototype.toString unchanged', Object.prototype.toString === beforeToString);
  check('Object.prototype.hasOwnProperty unchanged', Object.prototype.hasOwnProperty === beforeHasOwn);
  check('no polluted property on plain object',
    Object.keys({}).length === 0 && !('polluted' in ({}).constructor.prototype));
}

// ─────────────────────────────────────────────────────────────
header('Config tab — bool toggle in place (Enter on bool field)');
{
  let s = ConfigTab.initialState();
  // Navigate to "Stealth preset" — index 2 in our FIELDS array
  s = ConfigTab.onKey(s, { name: 'down', ch: '', ctrl: false, shift: false, meta: false });
  s = ConfigTab.onKey(s, { name: 'down', ch: '', ctrl: false, shift: false, meta: false });
  // Press Enter — bool toggles in place, no edit buffer
  const toggled = ConfigTab.onKey(s, { name: 'enter', ch: '', ctrl: false, shift: false, meta: false });
  check('bool toggle: editBuffer null',    toggled.editBuffer === null);
  check('bool toggle: value flipped',      toggled.config.stealth !== s.config.stealth);
}

// ─────────────────────────────────────────────────────────────
header('Analytics tab — loading + populated states');
{
  const initial = AnalyticsTab.initialState();
  const r1 = AnalyticsTab.render(initial, DIM);
  check('initial: shows Loading',          r1.includes('Loading'));

  const populated = {
    ...initial,
    loading: false,
    summary: {
      window: {
        minutes: 60, requests: 247,
        totalInputTokens: 142830, totalOutputTokens: 38200, totalThinkingTokens: 9000,
        estimatedCost: 1.23, avgLatencyMs: 1234,
        subscriptionPercent: 95,
        billingBucketBreakdown: { subscription: 240, extra_usage: 7, api: 0, unknown: 0, subscription_fallback: 0 },
      },
      allTime: { requests: 1000 },
      perModel: {
        'claude-opus-4-7':  { requests: 178, totalInputTokens: 100000, totalOutputTokens: 25000 },
        'claude-sonnet-4-6': { requests: 54, totalInputTokens: 40000, totalOutputTokens: 12000 },
      },
      utilization: { lastUtil5h: 0.18, lastUtil7d: 0.08 },
    },
    lastFetchAt: Date.now(),
  };
  const r2 = AnalyticsTab.render(populated, DIM);
  check('populated: shows 247 requests',   r2.includes('247'));
  check('populated: shows opus row',       r2.includes('opus-4-7'));
  check('populated: shows sonnet row',     r2.includes('sonnet-4-6'));
  check('populated: shows 5h % label',     r2.includes('18%'));
  check('populated: shows 7d % label',     r2.includes('8%'));
  check('populated: shows Per-model',      r2.includes('Per-model'));
  // #600 regression — subscriptionPercent is already 0–100; the gauge must not
  // multiply by 100 again (the bug rendered "9500%" / "10000%").
  check('populated: subscription % not double-scaled', r2.includes('95%') && !r2.includes('9500%'));

  // Error state
  const errored = {
    ...initial,
    summary: null,
    loading: false,
    error: 'ECONNREFUSED',
  };
  const r3 = AnalyticsTab.render(errored, DIM);
  check('error: surfaces error message',   r3.includes('ECONNREFUSED'));
  check('error: hints at proxy start',     r3.includes('dario proxy'));

  // #600 — with >1 account, rate-limit renders per-account rows (each account
  // has its own 5h/7d windows; an aggregate gauge would be misleading).
  const multiAcct = {
    ...initial,
    loading: false,
    summary: {
      window: {
        minutes: 60, requests: 30,
        totalInputTokens: 1000, totalOutputTokens: 200, totalThinkingTokens: 0,
        estimatedCost: 0.1, avgLatencyMs: 500, subscriptionPercent: 100,
        billingBucketBreakdown: { subscription: 30 },
      },
      allTime: { requests: 30 },
      perModel: { 'claude-opus-4-8': { requests: 30, totalInputTokens: 1000, totalOutputTokens: 200 } },
      utilization: { lastUtil5h: 0.42, lastUtil7d: 0.12 },
      perAccount: {
        primary: { requests: 20, currentUtil5h: 0.42, currentUtil7d: 0.12, lastClaim: 'five_hour' },
        backup:  { requests: 10, currentUtil5h: 0.18, currentUtil7d: 0.08, lastClaim: 'five_hour' },
      },
    },
    lastFetchAt: Date.now(),
  };
  const r4 = AnalyticsTab.render(multiAcct, DIM);
  check('per-account: section labelled',    r4.includes('per account'));
  check('per-account: shows primary alias', r4.includes('primary'));
  check('per-account: shows backup alias',  r4.includes('backup'));
  check('per-account: primary peak 42%',    r4.includes('42%'));
  check('per-account: backup 5h 18%',       r4.includes('18%'));
}

// ─────────────────────────────────────────────────────────────
header('Hits tab — empty / connecting / populated / selected');
{
  const initial = HitsTab.initialState();
  const r1 = HitsTab.render(initial, DIM);
  check('initial: connecting hint',        r1.includes('Connecting') || r1.includes('Waiting'));

  // Subscribed but no records yet
  const subscribed = { ...initial, subscribed: true };
  const r2 = HitsTab.render(subscribed, DIM);
  check('subscribed empty: waiting hint',  r2.includes('Waiting'));

  // With records
  const records = [
    {
      timestamp: Date.now() - 5000, account: 'default', model: 'claude-opus-4-7',
      inputTokens: 842, outputTokens: 216, cacheReadTokens: 6200, cacheCreateTokens: 0, thinkingTokens: 84,
      claim: 'five_hour', util5h: 0.18, util7d: 0.08, overageUtil: 0,
      latencyMs: 1180, status: 200, isStream: true, isOpenAI: false,
    },
    {
      timestamp: Date.now() - 3000, account: 'default', model: 'claude-sonnet-4-6',
      inputTokens: 1200, outputTokens: 480, cacheReadTokens: 0, cacheCreateTokens: 0, thinkingTokens: 0,
      claim: 'five_hour', util5h: 0.18, util7d: 0.08, overageUtil: 0,
      latencyMs: 820, status: 200, isStream: false, isOpenAI: false,
    },
  ];
  const populated = { ...initial, buffer: records, subscribed: true, selectedIdx: 0 };
  const r3 = HitsTab.render(populated, DIM);
  check('populated: shows opus row',       r3.includes('opus-4-7'));
  check('populated: shows sonnet row',     r3.includes('sonnet-4-6'));
  check('populated: shows live marker',    r3.includes('live'));
  check('populated: detail section',       r3.includes('Selected') || r3.includes('Tokens'));

  // Up/down navigation — Down moves toward older (higher idx), Up toward newer (lower idx)
  const moved = HitsTab.onKey(populated, { name: 'down', ch: '', ctrl: false, shift: false, meta: false });
  check('down arrow moves selectedIdx',    moved && moved.selectedIdx === 1);
  const moved2 = HitsTab.onKey(moved, { name: 'up', ch: '', ctrl: false, shift: false, meta: false });
  check('up arrow moves selectedIdx',      moved2 && moved2.selectedIdx === 0);
}

// ─────────────────────────────────────────────────────────────
header('Accounts tab — empty + populated');
{
  const empty = { loading: false, accounts: [], error: null };
  const r1 = AccountsTab.render(empty, DIM);
  check('empty: shows guidance',           r1.includes('No accounts') || r1.includes('Add one'));

  const populated = {
    loading: false,
    accounts: [
      { alias: 'default', expiresAt: Date.now() + 7 * 3600_000 },
      { alias: 'work',    expiresAt: Date.now() - 100 },
    ],
    error: null,
  };
  const r2 = AccountsTab.render(populated, DIM);
  check('populated: shows default row',    r2.includes('default'));
  check('populated: shows work row',       r2.includes('work'));
  check('populated: shows expired',        r2.includes('expired'));
}

// ─────────────────────────────────────────────────────────────
// dario reads utilization off the rate-limit headers of responses it
// proxies, so a proxy that has served nothing knows nothing. Rendering that
// as `0%` is a claim about the operator's quota that dario has not earned —
// reported live as `util5h 0%  util7d 0%` on an account whose windows were
// demonstrably part-spent. `measuredAt` is what tells the two apart.
header('Accounts tab — never-measured utilization renders as —, not 0%');
{
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  /** All lines belonging to one alias's card (header + indented detail). */
  const cardBlock = (rendered, alias) => {
    const lines = strip(rendered).split('\n');
    const headerIdx = lines.findIndex((l) => l.includes(alias));
    if (headerIdx === -1) return '';
    let end = headerIdx + 1;
    while (end < lines.length && /^\s{4}/.test(lines[end])) end++;
    return lines.slice(headerIdx, end).join('\n');
  };
  /** Both utilization labels show a dash (—) when unmeasured. */
  const bothDashed = (block) => (block.match(/—/g) ?? []).length >= 2;

  const unmeasured = {
    loading: false,
    source: 'pool',
    accounts: [{ alias: 'login', expiresAt: Date.now() + 3600_000, util5h: 0, util7d: 0, status: 'unknown', measuredAt: 0 }],
    error: null,
  };
  const r1 = strip(AccountsTab.render(unmeasured, DIM));
  check('unmeasured: no 0% claim',         !r1.includes('0%'));
  check('unmeasured: renders a dash',      bothDashed(cardBlock(r1, 'login')));
  check('unmeasured: explains why',        r1.includes('none seen yet this run'));
  check('unmeasured: names the probe',     r1.includes('dario doctor --usage'));

  // A measured zero is a real reading and must still print as 0%.
  const measuredZero = {
    loading: false,
    source: 'pool',
    accounts: [{ alias: 'login', expiresAt: Date.now() + 3600_000, util5h: 0, util7d: 0, status: 'allowed', measuredAt: Date.now() }],
    error: null,
  };
  const r2 = strip(AccountsTab.render(measuredZero, DIM));
  check('measured zero: prints 0%',        r2.includes('0%'));
  check('measured zero: drops the hint',   !r2.includes('none seen yet this run'));

  const measured = {
    loading: false,
    source: 'pool',
    accounts: [{ alias: 'login', expiresAt: Date.now() + 3600_000, util5h: 0.62, util7d: 0.31, status: 'allowed', measuredAt: Date.now() }],
    error: null,
  };
  const r3 = strip(AccountsTab.render(measured, DIM));
  check('measured: prints the figures',    r3.includes('62%') && r3.includes('31%'));

  // A mixed pool must not suppress the hint for the seat that does have data.
  const mixed = {
    loading: false,
    source: 'pool',
    accounts: [
      { alias: 'a', expiresAt: Date.now() + 3600_000, util5h: 0.5, util7d: 0.2, status: 'allowed', measuredAt: Date.now() },
      { alias: 'b', expiresAt: Date.now() + 3600_000, util5h: 0, util7d: 0, status: 'unknown', measuredAt: 0 },
    ],
    error: null,
  };
  const r4 = strip(AccountsTab.render(mixed, DIM));
  check('mixed: measured seat keeps its figures', r4.includes('50%') && r4.includes('20%'));
  check('mixed: unmeasured seat still dashes',    bothDashed(cardBlock(r4, 'b')));
  check('mixed: no pool-wide hint',               !r4.includes('none seen yet this run'));

  // A proxy predating `measuredAt` omits the field. Blanking every column
  // there would be a regression against the old behaviour, so absence falls
  // back to the previous "util present means show it" rule.
  const legacy = {
    loading: false,
    source: 'pool',
    accounts: [{ alias: 'login', expiresAt: Date.now() + 3600_000, util5h: 0.42, util7d: 0.1, status: 'allowed' }],
    error: null,
  };
  const r5 = strip(AccountsTab.render(legacy, DIM));
  check('legacy proxy without measuredAt still renders', r5.includes('42%'));
}

// ─────────────────────────────────────────────────────────────
// The quota card, mirroring the cli-proxy-api management-center layout the
// operator asked for. Every percentage here is REMAINING, so the meter reads
// as a fuel gauge: a nearly-spent window is a short red stub, not a long one.
header('Accounts tab — control-plane quota card');
{
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const NOW = Date.now();
  const card = {
    loading: false,
    source: 'pool',
    accounts: [{
      alias: 'login',
      // Half an hour of slack: `formatExpiry` floors, so an exact 7h
      // expiry renders `6h 59m` as soon as a millisecond elapses — which it
      // does whenever the suite runs under load.
      expiresAt: NOW + 7 * 3600_000 + 30 * 60_000,
      util5h: 0.03, util7d: 0.82, status: 'allowed_warning', measuredAt: NOW,
      quota: {
        plan: 'Max',
        windows: [
          { id: 'five-hour', label: '5-hour limit', remainingPercent: 97, resetsAt: NOW + 4 * 3600_000 },
          { id: 'seven-day', label: '7-day limit', remainingPercent: 18, resetsAt: NOW + 2 * 86_400_000 },
          { id: 'seven-day-fable', label: '7-day Fable 5', remainingPercent: 0, resetsAt: NOW + 2 * 86_400_000 },
        ],
      },
    }],
    error: null,
  };
  const r = AccountsTab.render(card, DIM);
  const plain = strip(r);

  check('card: shows the plan',            /Plan\s+Max/.test(plain));
  check('card: names the alias',           plain.includes('login'));
  check('card: token expiry still visible', /token\s+7h/.test(plain));
  check('card: 5-hour row',                /5-hour limit\s+97%/.test(plain));
  check('card: 7-day row',                 /7-day limit\s+18%/.test(plain));
  check('card: Fable row uses the model name', /7-day Fable 5\s+0%/.test(plain));
  check('card: absolute reset instant',    /\d\d\/\d\d, \d\d:\d\d/.test(plain));
  check('card: relative countdown',        /in \d+ (hour|day|minute)/.test(plain));
  check('card: refresh hint mentions quota', plain.includes('refresh quota'));

  // The card supersedes the util table — showing both would print the same
  // account twice under two different conventions (used vs remaining).
  check('card: util table is suppressed',  !plain.includes('util5h'));

  // Meter direction: a 97%-remaining window is nearly full, a 0% one empty.
  const bars = plain.split('\n').filter((l) => /[█░]/.test(l));
  check('card: one meter per window',      bars.length === 3);
  const filled = (l) => (l.match(/█/g) ?? []).length;
  check('card: full window has a long bar', filled(bars[0]) > filled(bars[1]));
  check('card: drained window has no fill', filled(bars[2]) === 0);

  // Banding is on remaining: high green, low red.
  const colored = r.split('\n').filter((l) => /[█░]/.test(l));
  check('card: healthy window is green',   colored[0].includes('[32m'));
  check('card: drained window is not green', !colored[2].includes('[32m'));

  // A quota fetch that failed must say so rather than render a blank card.
  const failed = {
    ...card,
    accounts: [{ ...card.accounts[0], quota: { plan: null, windows: [], error: 'HTTP 401' } }],
  };
  const rf = strip(AccountsTab.render(failed, DIM));
  check('failed fetch: falls back to the util table', rf.includes('util5h'));

  // No quota at all (older proxy) degrades to the pre-existing table.
  const noQuota = { ...card, accounts: [{ ...card.accounts[0], quota: undefined }] };
  const rn = strip(AccountsTab.render(noQuota, DIM));
  check('no quota: util table renders',    rn.includes('util5h') && rn.includes('82%'));
}

// ─────────────────────────────────────────────────────────────
header('Backends tab — empty + populated');
{
  const empty = { loading: false, backends: [], error: null };
  const r1 = BackendsTab.render(empty, DIM);
  check('empty: shows guidance',           r1.includes('No OpenAI') || r1.includes('Add one'));

  const populated = {
    loading: false,
    backends: [
      { name: 'openai',     provider: 'openai', baseUrl: 'https://api.openai.com/v1' },
      { name: 'groq',       provider: 'openai', baseUrl: 'https://api.groq.com/openai/v1' },
    ],
    error: null,
  };
  const r2 = BackendsTab.render(populated, DIM);
  check('populated: shows openai',         r2.includes('openai'));
  check('populated: shows groq',           r2.includes('groq'));
}

// ─────────────────────────────────────────────────────────────
header('All tabs render without throwing across many dimensions');
{
  for (const dimv of [
    { cols: 60, rows: 20 },
    { cols: 100, rows: 30 },
    { cols: 200, rows: 50 },
  ]) {
    for (const [name, tab] of [
      ['Status', StatusTab], ['Analytics', AnalyticsTab],
      ['Hits', HitsTab], ['Accounts', AccountsTab], ['Backends', BackendsTab],
    ]) {
      try {
        const out = tab.render(tab.initialState(), dimv);
        check(`${name} ${dimv.cols}x${dimv.rows} renders without throw`, typeof out === 'string');
      } catch (err) {
        check(`${name} ${dimv.cols}x${dimv.rows} renders without throw`, false, err.message);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
header('Config tab — body fits its row budget at every size');
{
  // TuiApp gives the body `rows - 5` and draws the frame from the top
  // with no scrollback, so a body that is taller than its budget — or
  // has a row wider than `cols`, which the terminal wraps onto a second
  // physical line — pushes the panel head off the top of the screen.
  for (const [cols, rows] of [[60, 20], [80, 24], [100, 30], [200, 50], [80, 12], [40, 8]]) {
    const bodyRows = rows - 5;
    let s = ConfigTab.initialState();
    // Walk the selection to the last field: the window must scroll and
    // still fit at both ends of the list.
    for (let i = 0; i < 30; i++) {
      const out = ConfigTab.render(s, { cols, rows: bodyRows });
      const rendered = out.split('\n');
      const widest = Math.max(...rendered.map(visibleWidth));
      check(`${cols}x${rows} idx=${s.selectedIdx}: no row exceeds cols`, widest <= cols, `widest=${widest}`);
      check(`${cols}x${rows} idx=${s.selectedIdx}: body within budget`, rendered.length <= bodyRows,
        `lines=${rendered.length} budget=${bodyRows}`);
      s = ConfigTab.onKey(s, { name: 'down', ch: '', ctrl: false, shift: false, meta: false }) ?? s;
    }
  }
  // Every field must be reachable — the selected row is always rendered.
  let s = ConfigTab.initialState();
  const dimv = { cols: 100, rows: 19 };
  for (let i = 0; i < 30; i++) {
    s = ConfigTab.onKey(s, { name: 'down', ch: '', ctrl: false, shift: false, meta: false }) ?? s;
  }
  check('scrolled to bottom: last field visible',
    ConfigTab.render(s, dimv).includes('Overage OS-notify'));
}

// ─────────────────────────────────────────────────────────────
header('truncate() closes every SGR attribute it opens');
{
  // A cut that lands inside a dim()/fg() span used to drop that span's
  // closing code, because the walk stops at `visible === target` and
  // returned immediately. The attribute then stayed on: it bled into
  // the next line and past the frame entirely, since App.redraw writes
  // `clearScreen + frame` and \x1b[2J\x1b[H does not reset SGR.
  const DEFAULT = { intensity: 0, underline: 0, inverse: 0, fg: 39, bg: 49 };

  // Replay a line's SGR codes and report the attributes left active.
  function sgrStateAtEnd(line) {
    const st = { ...DEFAULT };
    for (const m of line.matchAll(/\x1b\[([0-9;]*)m/g)) {
      const ps = m[1] === '' ? [0] : m[1].split(';').map(Number);
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        if (p === 0) Object.assign(st, DEFAULT);
        else if (p === 1 || p === 2) st.intensity = p;
        else if (p === 22) st.intensity = 0;
        else if (p === 4) st.underline = 4;
        else if (p === 24) st.underline = 0;
        else if (p === 7) st.inverse = 7;
        else if (p === 27) st.inverse = 0;
        else if (p === 38 || p === 48) {
          const k = p === 38 ? 'fg' : 'bg';
          if (ps[i + 1] === 5) { st[k] = p; i += 2; }
          else if (ps[i + 1] === 2) { st[k] = p; i += 4; }
        }
        else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) st.fg = p;
        else if (p === 39) st.fg = 39;
        else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) st.bg = p;
        else if (p === 49) st.bg = 49;
      }
    }
    return st;
  }
  const balanced = (line) => JSON.stringify(sgrStateAtEnd(line)) === JSON.stringify(DEFAULT);

  // The checker must be able to fail, or everything below is vacuous.
  check('control: an unbalanced line IS detected', !balanced('x \x1b[2mclipped'));
  check('control: a balanced line is NOT flagged', balanced(dim('fine') + ' plain'));

  // Cut inside a trailing dim() span at a spread of widths.
  const styled = '  label:  value  ' + dim('— halt proxy on any representative-claim=overage');
  for (const w of [20, 30, 40, 60, 80, 100]) {
    const t = truncate(styled, w);
    check(`truncate w=${w}: within width`, visibleWidth(t) <= w, `got ${visibleWidth(t)}`);
    check(`truncate w=${w}: no attribute left open`, balanced(t), JSON.stringify(sgrStateAtEnd(t)));
  }

  // The fix replays the clipped remainder's own codes rather than
  // appending a blanket reset — a reset would end an enclosing
  // inverse() before the row's trailing padding, dropping the
  // highlight off the right edge of the selected row.
  {
    const w = 80;
    const raw = '  ' + pad('Overage-guard:', 26) + pad('true', 16) + '  ' +
      dim('— halt proxy on any representative-claim=overage');
    const row = inverse(pad(truncate(raw, w), w));
    check('selected row: no blanket reset inside', !/\x1b\[0m/.test(row));
    check('selected row: inverse survives to the end of the padding',
      sgrStateAtEnd(row.slice(0, row.lastIndexOf('\x1b[27m'))).inverse === 7);
    check('selected row: balanced overall', balanced(row));
  }

  // Config rows end in a dim() hint, so this is the tab that clips one
  // on a default-width terminal. Walk the selection at each geometry.
  for (const [cols, rows] of [[40, 8], [60, 20], [80, 24], [100, 30], [120, 40], [200, 50]]) {
    let s = ConfigTab.initialState();
    let leaks = 0;
    for (let i = 0; i < 20; i++) {
      for (const line of ConfigTab.render(s, { cols, rows: rows - 5 }).split('\n')) {
        if (!balanced(line)) leaks++;
      }
      s = ConfigTab.onKey(s, { name: 'down', ch: '', ctrl: false, shift: false, meta: false }) ?? s;
    }
    check(`Config ${cols}x${rows}: no line leaves an attribute open`, leaks === 0, `${leaks} leaking lines`);
  }

  // renderFooter truncates cyan key hints and hit the same bug.
  {
    const hints = [{ key: 'Tab', label: 'next tab' }, { key: 'q', label: 'quit' }, { key: 'r', label: 'refresh' }];
    let leaks = 0;
    for (let cols = 4; cols <= 60; cols++) if (!balanced(renderFooter(cols, hints))) leaks++;
    check('renderFooter: no width leaves an attribute open', leaks === 0, `${leaks} leaking widths`);
  }
}

// ─────────────────────────────────────────────────────────────
header('Hits tab — no row exceeds the terminal width');
{
  // The data rows were already truncated and the detail pane is bounded
  // by renderKvRow, but the tab's chrome — title, halt banner, column
  // header, empty-state copy, scroll hint — was pushed unbounded. A row
  // wider than `cols` wraps onto a second physical line, and renderTui
  // measures body height with a logical line count (tui-app.ts:282), so
  // the surplus pushes the panel head off the top of the screen. See #862.
  const rec = (i, status, claim) => ({
    timestamp: 1753480000000 + i * 1000,
    account: 'thomas@sprayberrylabs.com',
    model: 'claude-opus-4-5-20260101',
    inputTokens: 12345, outputTokens: 6789,
    cacheReadTokens: 1024, cacheCreateTokens: 512, thinkingTokens: 256,
    claim, util5h: 0.42, util7d: 0.17, overageUtil: 0,
    latencyMs: 1234, status, isStream: true, isOpenAI: false,
  });
  const buffer = [rec(0, 200, 'subscription'), rec(1, 429, 'overage'), rec(2, 500, 'api'), rec(3, 404, 'subscription')];
  const halt = {
    since: 1753480000000,
    cooldownUntil: 1753481800000,
    request: { claim: 'overage', model: 'claude-opus-4-5-20260101', account: 'thomas@sprayberrylabs.com' },
  };

  const STATES = {
    'connecting':   (s) => { s.buffer = []; s.subscribed = false; },
    'waiting':      (s) => { s.buffer = []; s.subscribed = true; },
    'sse error':    (s) => { s.buffer = []; s.connectionError = 'connect ECONNREFUSED 127.0.0.1:3456 — upstream closed the stream unexpectedly after 3 retries'; },
    'populated':    (s) => { s.buffer = buffer; s.subscribed = true; },
    'halted':       (s) => { s.buffer = buffer; s.subscribed = true; s.halt = halt; },
    'no selection': (s) => { s.buffer = buffer; s.subscribed = true; s.selectedIdx = -1; },
  };

  for (const [label, mutate] of Object.entries(STATES)) {
    let worst = 0, worstAt = null;
    for (let cols = 30; cols <= 160; cols++) {
      const s = HitsTab.initialState();
      mutate(s);
      for (const line of HitsTab.render(s, { cols, rows: 24 }).split('\n')) {
        const over = visibleWidth(line) - cols;
        if (over > worst) { worst = over; worstAt = `cols=${cols} width=${visibleWidth(line)}`; }
      }
    }
    check(`Hits [${label}]: every row fits, cols 30-160`, worst === 0, worstAt);
  }

  // The halt banner is pinned visible while scrolling, so it has to fit a
  // standard terminal outright — clipping it would hide the resume path.
  {
    const s = HitsTab.initialState();
    s.buffer = buffer; s.subscribed = true; s.halt = halt;
    const [l1, l2] = HitsTab.render(s, { cols: 80, rows: 24 }).split('\n').slice(1, 3);
    // Both halves matter: within 80 (the pre-fix banner was 105/106) AND
    // not clipped to get there, so the reflow is doing the work.
    check('halt banner line 1 fits 80 unclipped',
      visibleWidth(l1) <= 80 && !l1.includes('…'), `width=${visibleWidth(l1)}`);
    check('halt banner line 2 fits 80 unclipped',
      visibleWidth(l2) <= 80 && !l2.includes('…'), `width=${visibleWidth(l2)}`);
    check('halt banner still names the claim', l1.includes('overage'));
    check('halt banner still shows the resume path', l2.includes('dario resume'));
  }
}

// ─────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
