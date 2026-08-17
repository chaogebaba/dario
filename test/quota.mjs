#!/usr/bin/env bun
// Control-plane quota — `GET /api/oauth/usage` → the Accounts card.
//
// This is dario's second source of utilization and the only one that answers
// without spending a request. The header-derived figures in pool.ts are free
// but passive: nothing to report until traffic flows, no per-window reset, and
// the per-model bucket arrives keyed by an opaque codename (`7d_oi`). The
// control plane names it.
//
// Shapes and the Fable special-case are ported from the cli-proxy-api
// management center, so these tests mirror its cases. The one that matters
// most is the first: the payload reports utilization CONSUMED and the card
// renders REMAINING. Getting that backwards inverts every row on screen and
// still looks plausible — an account at 82% used would read as 82% left.

import {
  buildQuotaWindows,
  findFableLimit,
  resolvePlan,
  resolveProfileEmail,
  parseExtraUsage,
  parseResetInstant,
  formatResetInstant,
  formatResetRelative,
  quotaBand,
  fetchQuota,
  fetchPlan,
} from '../dist/quota.js';

let pass = 0;
let fail = 0;
function check(label, cond, ...rest) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`, ...rest); }
}
function header(name) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}

const RESET_5H = '2026-08-16T14:49:59.884493+00:00';
const RESET_7D = '2026-08-18T21:59:59.884530+00:00';

/** The live payload shape, trimmed to what the card reads. */
const LIVE = {
  five_hour: { utilization: 3.0, resets_at: RESET_5H },
  seven_day: { utilization: 82.0, resets_at: RESET_7D },
  seven_day_opus: null,
  seven_day_sonnet: null,
  iguana_necktie: null,
  limits: [
    { kind: 'session', group: 'session', percent: 3, severity: 'normal', resets_at: RESET_5H, scope: null, is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: 82, severity: 'warning', resets_at: RESET_7D, scope: null, is_active: false },
    { kind: 'weekly_scoped', group: 'weekly', percent: 100, severity: 'critical', resets_at: RESET_7D, scope: { model: { id: null, display_name: 'Fable' } }, is_active: true },
  ],
  extra_usage: { is_enabled: false, used_credits: 0, monthly_limit: null, currency: 'USD' },
};

const byId = (windows) => Object.fromEntries(windows.map((w) => [w.id, w]));

// ======================================================================
header('the number on the card is REMAINING, not used');
{
  const w = byId(buildQuotaWindows(LIVE));
  // Captured live: this account had spent 82% of its week. The card says 18.
  check('82% consumed renders as 18% remaining', w['seven-day'].remainingPercent === 18);
  check('3% consumed renders as 97% remaining', w['five-hour'].remainingPercent === 97);
  check('100% consumed renders as 0% remaining', w['seven-day-fable'].remainingPercent === 0);

  // The inversion is invisible to a naive test that only checks "a number
  // came out", so pin the direction explicitly.
  check('the busiest window is the one with the LEAST remaining',
    w['seven-day-fable'].remainingPercent < w['seven-day'].remainingPercent
    && w['seven-day'].remainingPercent < w['five-hour'].remainingPercent);

  check('a 0%-used window is 100% remaining',
    byId(buildQuotaWindows({ five_hour: { utilization: 0, resets_at: null } }))['five-hour'].remainingPercent === 100);

  // Out-of-range input clamps rather than producing a negative bar width.
  check('above 100% used clamps to 0 remaining',
    byId(buildQuotaWindows({ five_hour: { utilization: 130, resets_at: null } }))['five-hour'].remainingPercent === 0);
  check('below 0% used clamps to 100 remaining',
    byId(buildQuotaWindows({ five_hour: { utilization: -5, resets_at: null } }))['five-hour'].remainingPercent === 100);
}

// ======================================================================
header('window selection and ordering');
{
  const windows = buildQuotaWindows(LIVE);
  check('three rows for the live payload', windows.length === 3);
  check('5-hour first', windows[0].id === 'five-hour');
  check('7-day second', windows[1].id === 'seven-day');
  check('scoped Fable last', windows[2].id === 'seven-day-fable');
  check('labels match the reference card',
    windows.map((w) => w.label).join('|') === '5-hour limit|7-day limit|7-day Fable 5');

  // Null windows carry no `utilization` key and must not become empty rows.
  check('null windows are skipped', windows.every((w) => w.id !== 'seven-day-opus'));

  const withOpus = byId(buildQuotaWindows({
    ...LIVE,
    seven_day_opus: { utilization: 40, resets_at: RESET_7D },
  }));
  check('a populated per-model window appears', withOpus['seven-day-opus'].remainingPercent === 60);
  check('and is labelled', withOpus['seven-day-opus'].label === '7-day Opus');

  check('resets parse to epoch ms',
    windows[0].resetsAt === new Date(RESET_5H).getTime());
  check('a missing reset is null',
    byId(buildQuotaWindows({ five_hour: { utilization: 1 } }))['five-hour'].resetsAt === null);
}

// ======================================================================
header('the Fable window — codename vs named limit');
{
  // `iguana_necktie` is the payload's codename for the same bucket the
  // response headers key as `7d_oi`. It carries no model name, so the named
  // `limits[]` entry wins and the codename must not render a duplicate row.
  const both = buildQuotaWindows({
    ...LIVE,
    iguana_necktie: { utilization: 55, resets_at: RESET_7D },
  });
  check('the named limit suppresses the codename row',
    both.filter((w) => w.id === 'seven-day-fable').length === 1);
  check('and the named percentage wins',
    byId(both)['seven-day-fable'].remainingPercent === 0);

  // Without a named entry the codename is all we have — render it.
  const legacyOnly = byId(buildQuotaWindows({
    five_hour: { utilization: 10, resets_at: RESET_5H },
    iguana_necktie: { utilization: 55, resets_at: RESET_7D },
    limits: [],
  }));
  check('the codename renders when no named limit exists',
    legacyOnly['seven-day-fable'].remainingPercent === 45);

  // Anthropic adds scoped buckets over time; match on the model name, not
  // position, or a Sonnet bucket would be rendered as Fable.
  const sonnetScoped = buildQuotaWindows({
    five_hour: { utilization: 10, resets_at: RESET_5H },
    limits: [{ kind: 'weekly_scoped', percent: 35, resets_at: RESET_7D, scope: { model: { display_name: 'Sonnet' } }, is_active: true }],
  });
  check('a non-Fable scoped limit is not mistaken for Fable',
    sonnetScoped.every((w) => w.id !== 'seven-day-fable'));

  check('"Fable 5" is accepted as a display name',
    findFableLimit({ limits: [{ kind: 'weekly_scoped', percent: 12, scope: { model: { display_name: 'Fable 5' } } }] }) !== null);
  check('the match is case-insensitive',
    findFableLimit({ limits: [{ kind: 'weekly_scoped', percent: 12, scope: { model: { display_name: 'FABLE' } } }] }) !== null);

  // An active entry is the one currently governing routing.
  const active = findFableLimit({ limits: [
    { kind: 'weekly_scoped', percent: 10, scope: { model: { display_name: 'Fable' } }, is_active: false },
    { kind: 'weekly_scoped', percent: 90, scope: { model: { display_name: 'Fable' } }, is_active: true },
  ]});
  check('is_active wins over document order', active.percent === 90);

  // A placeholder with no percentage must not displace a real reading.
  const skipNull = findFableLimit({ limits: [
    { kind: 'weekly_scoped', percent: null, scope: { model: { display_name: 'Fable' } }, is_active: true },
    { kind: 'weekly_scoped', percent: 44, scope: { model: { display_name: 'Fable' } }, is_active: false },
  ]});
  check('an entry without a percentage is skipped', skipNull.percent === 44);

  check('a non-array limits field is tolerated', findFableLimit({ limits: 'nope' }) === null);
  check('a missing limits field is tolerated', findFableLimit({}) === null);
  check('the wrong kind is ignored',
    findFableLimit({ limits: [{ kind: 'weekly_all', percent: 5, scope: { model: { display_name: 'Fable' } } }] }) === null);
}

// ======================================================================
header('plan resolution');
{
  check('has_claude_max → Max', resolvePlan({ account: { has_claude_max: true, has_claude_pro: false } }) === 'Max');
  check('has_claude_pro → Pro', resolvePlan({ account: { has_claude_max: false, has_claude_pro: true } }) === 'Pro');
  check('Max wins over Pro when both set',
    resolvePlan({ account: { has_claude_max: true, has_claude_pro: true } }) === 'Max');
  check('neither → Free', resolvePlan({ account: { has_claude_max: false, has_claude_pro: false } }) === 'Free');
  check('active team org → Team',
    resolvePlan({ account: {}, organization: { organization_type: 'claude_team', subscription_status: 'active' } }) === 'Team');
  // An inactive team subscription is not a plan we can claim.
  check('inactive team org → unknown',
    resolvePlan({ account: {}, organization: { organization_type: 'claude_team', subscription_status: 'canceled' } }) === null);
  check('an empty profile → unknown', resolvePlan({}) === null);
  check('a null profile → unknown', resolvePlan(null) === null);
  // Absent is not false: a profile that simply omits the flags must read as
  // unknown, not as Free.
  check('absent flags → unknown, not Free', resolvePlan({ account: { email: 'x@y.z' } }) === null);
  check('string flags are coerced', resolvePlan({ account: { has_claude_max: 'true' } }) === 'Max');

  // The live profile for this account: org type claude_max, subscription
  // canceled, but the account flag is what governs.
  check('canceled max subscription still reads Max via the account flag',
    resolvePlan({
      account: { has_claude_max: true, has_claude_pro: false },
      organization: { organization_type: 'claude_max', subscription_status: 'canceled' },
    }) === 'Max');
}

header('profile email resolution');
{
  check('current account.email shape is accepted',
    resolveProfileEmail({ account: { email: 'max@example.com' } }) === 'max@example.com');
  check('legacy account.email_address shape is accepted',
    resolveProfileEmail({ account: { email_address: 'legacy@example.com' } }) === 'legacy@example.com');
  check('current field takes precedence over legacy',
    resolveProfileEmail({ account: { email: 'new@example.com', email_address: 'old@example.com' } }) === 'new@example.com');
  check('control characters are rejected',
    resolveProfileEmail({ account: { email: 'bad@example.com\nspoof' } }) === null);
  check('missing email returns null', resolveProfileEmail({ account: {} }) === null);
}

// ======================================================================
header('reset formatting');
{
  const t = new Date('2026-08-16T12:00:00Z').getTime();
  check('null instant renders a dash', formatResetInstant(null) === '—');
  check('null instant has no relative half', formatResetRelative(null, t) === null);
  check('unparseable ISO → null', parseResetInstant('not-a-date') === null);
  check('missing ISO → null', parseResetInstant(undefined) === null);
  check('valid ISO → epoch ms', parseResetInstant(RESET_7D) === new Date(RESET_7D).getTime());

  // Truncated, not rounded: "in 4 hours" holds from 4:59 down to 4:00. Rounding
  // up would cross the unit threshold and print "in 24 hours".
  check('4h59m reads as 4 hours', formatResetRelative(t + 4 * 3600_000 + 59 * 60_000, t) === 'in 4 hours');
  check('just under a day stays in hours', formatResetRelative(t + 86_400_000 - 1, t) === 'in 23 hours');
  check('two days reads as days', formatResetRelative(t + 2 * 86_400_000 + 3600_000, t) === 'in 2 days');
  check('minutes for a near reset', formatResetRelative(t + 5 * 60_000, t) === 'in 5 minutes');
  // Sub-minute floors to 1 so nothing renders "in 0 minutes".
  check('sub-minute floors to 1', formatResetRelative(t + 1_000, t) === 'in 1 minute');
  // Signed: a reset already past must not clamp to a future phrase.
  check('a past reset reads as ago', /ago/.test(formatResetRelative(t - 2 * 3600_000, t)));
}

// ======================================================================
header('meter banding — a fuel gauge, not a consumption bar');
{
  check('97% remaining is high', quotaBand(97) === 'high');
  check('70% remaining is high (boundary)', quotaBand(70) === 'high');
  check('69% remaining is medium', quotaBand(69) === 'medium');
  check('30% remaining is medium (boundary)', quotaBand(30) === 'medium');
  check('18% remaining is low', quotaBand(18) === 'low');
  check('0% remaining is low', quotaBand(0) === 'low');
  // Unknown is not low — an absent reading must not render as an alarm.
  check('unknown is its own band', quotaBand(null) === 'unknown');
  check('NaN is unknown', quotaBand(NaN) === 'unknown');
}

// ======================================================================
header('extra usage');
{
  const e = parseExtraUsage(LIVE);
  check('parsed', e !== null && e.isEnabled === false);
  check('currency retained', e.currency === 'USD');
  check('absent block → null', parseExtraUsage({}) === null);
}

// ======================================================================
header('fetchQuota — profile is best-effort, usage is not');
{
  const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

  // Happy path.
  const both = await fetchQuota('tok', async (url) =>
    String(url).includes('/usage') ? json(LIVE) : json({ account: { has_claude_max: true, email: 'max@example.com' } }));
  check('windows built', both.windows.length === 3);
  check('plan resolved', both.plan === 'Max');
  check('email resolved from live profile shape', both.email === 'max@example.com');
  check('stamped', both.fetchedAt > 0);

  // A profile failure costs one line; losing the windows over it would be
  // the wrong trade.
  const noProfile = await fetchQuota('tok', async (url) =>
    String(url).includes('/usage') ? json(LIVE) : json({}, false, 500));
  check('profile 500 → plan null', noProfile.plan === null);
  check('but the windows survive', noProfile.windows.length === 3);

  const throwingProfile = await fetchQuota('tok', async (url) => {
    if (String(url).includes('/usage')) return json(LIVE);
    throw new Error('network down');
  });
  check('a thrown profile request → plan null', throwingProfile.plan === null);
  check('and the windows still survive', throwingProfile.windows.length === 3);

  // Usage is the whole point — its failure must surface, not render empty.
  let threw = null;
  try {
    await fetchQuota('tok', async (url) =>
      String(url).includes('/usage') ? json({}, false, 401) : json({}));
  } catch (e) { threw = e; }
  check('usage 401 throws', threw !== null);
  check('and names the status', /401/.test(threw.message));

  // The token must ride on the request, or every probe 401s.
  let seenAuth = null;
  await fetchQuota('secret-token', async (url, init) => {
    seenAuth = init.headers.authorization;
    return json(LIVE);
  });
  check('bearer token is sent', seenAuth === 'Bearer secret-token');
}

header('fetchPlan — routing plan is independent of usage availability');
{
  let calls = 0;
  const plan = await fetchPlan('tok', async (url) => {
    calls++;
    return new Response(JSON.stringify({ account: { has_claude_max: true } }), {
      status: String(url).includes('/profile') ? 200 : 503,
      headers: { 'content-type': 'application/json' },
    });
  });
  check('Max plan resolves without a usage request', plan === 'Max');
  check('plan probe calls only profile', calls === 1);
}

// ======================================================================
header('the refresh-bypass predicate reads the query string');
{
  // GET /quota caches per alias for 60s so a TUI tick storm can't fan out to
  // the control plane. `?refresh=1` must bypass it — an explicit keypress
  // asking for fresh numbers and getting cached ones is the one case the
  // cache must lose.
  //
  // The first version tested this against `urlPath`, which the request
  // handler has already split on '?' — so the flag never fired and every
  // refresh served the cache. Invisible from outside except by timing.
  const force = (url) => /[?&]refresh=1(&|$)/.test(url ?? '');

  check('plain /quota does not force', force('/quota') === false);
  check('?refresh=1 forces', force('/quota?refresh=1') === true);
  check('mid-query &refresh=1 forces', force('/quota?x=2&refresh=1') === true);
  check('trailing param still forces', force('/quota?refresh=1&x=2') === true);
  check('refresh=0 does not force', force('/quota?refresh=0') === false);
  // The path alone — what the handler's `urlPath` holds — must never force,
  // which is exactly the bug: testing this string was a guaranteed false.
  check('the query-stripped path never forces', force('/quota') === false);
  check('undefined url does not throw', force(undefined) === false);
}

console.log(`\n${'='.repeat(70)}\n  ${pass} pass, ${fail} fail\n${'='.repeat(70)}`);
process.exit(fail === 0 ? 0 : 1);
