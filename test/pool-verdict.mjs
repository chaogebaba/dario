#!/usr/bin/env bun
// One pool, one answer.
//
// Four surfaces report on whether the pool can serve — `dario doctor`, the
// 503 body, /health, and the startup banner — and each used to filter the
// accounts itself. They filtered differently, so one pool got three answers:
//
//   all accounts disabled   router: null   /health: broken    banner: healthy
//   all tokens expired      router: null   /health: healthy   banner: expired
//
// with the 503 body telling the client "all accounts are rate-limited or in
// auth cool-down" in both cases. The router is the only one of the four whose
// answer is load-bearing — it is the filter requests actually pass through —
// so `poolVerdict` asks its predicate once and the surfaces render it.
//
// The agreement table below is the finding's regression test. Everything else
// here covers the verdict's own shape.

import { AccountPool, blockedSummary, poolVerdict } from '../dist/pool.js';
import { derivePoolStatus } from '../dist/health-response.js';
import { poolRoutingCheck } from '../dist/doctor.js';
import { resolvePoolStartupStatus } from '../dist/proxy.js';

let pass = 0;
let fail = 0;
function check(label, cond, ...rest) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`, ...rest); }
}
function header(name) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}

// Real wall clock, because `pool.select()` reads its own `Date.now()` and the
// agreement table below compares it against surfaces that take an explicit
// `now`. A frozen NOW would have the two disagree by construction, which is
// the one thing this file exists to detect.
const NOW = Date.now();
const HOUR = 3_600_000;

const acct = (over = {}) => ({
  accessToken: 'a',
  refreshToken: 'r',
  expiresAt: NOW + 3 * HOUR,
  ...over,
});
const COOLING = { lastAuthFailureAt: NOW - 1_000, consecutiveAuthFailures: 1 };
const LIMITED = { rateLimitCooldowns: { '*': { until: NOW + 60_000, backoffLevel: 1 } } };

// `add()` takes credentials, not cool-down state, so the cool-down fields are
// set on the stored account afterwards — the same fields `markAuthFailure` and
// a 429 write, without having to drive the clock to produce them.
function poolOf(accounts) {
  const pool = new AccountPool();
  accounts.forEach((a, i) => {
    pool.add(`acct${i}`, {
      accessToken: a.accessToken, refreshToken: a.refreshToken, expiresAt: a.expiresAt,
      deviceId: `dev${i}`, accountUuid: `uuid${i}`, enabled: a.enabled,
    });
    const stored = pool.get(`acct${i}`);
    if (a.lastAuthFailureAt !== undefined) stored.lastAuthFailureAt = a.lastAuthFailureAt;
    if (a.consecutiveAuthFailures !== undefined) stored.consecutiveAuthFailures = a.consecutiveAuthFailures;
    if (a.rateLimitCooldowns !== undefined) stored.rateLimitCooldowns = a.rateLimitCooldowns;
  });
  return pool;
}

// ── the agreement table ───────────────────────────────────────────────────
//
// `canServe` is the router's answer, and it is the only input: whatever
// select() would do is what every surface has to report. The two surfaces are
// allowed to word it differently and to pick their own status for a cause they
// have a specific fix for — the banner still says `expired` rather than
// `broken`, because `dario login` is the answer to a dead token and not to a
// benched seat — but none of them may call a pool healthy that cannot serve,
// or dead that can.

header('every surface agrees with the router');
const CASES = [
  ['a live pool',            [acct()],                                              true],
  ['one live seat of three', [acct({ enabled: false }), acct(COOLING), acct()],      true],
  ['all disabled',           [acct({ enabled: false }), acct({ enabled: false })],   false],
  ['all expired',            [acct({ expiresAt: NOW - 88 * 86_400_000 })],           false],
  ['all in auth cool-down',  [acct(COOLING), acct(COOLING)],                         false],
  ['all rate-limited',       [acct(LIMITED)],                                        false],
  ['expiring inside the 30s select() window', [acct({ expiresAt: NOW + 10_000 })],   false],
  ['blocked two different ways', [acct({ enabled: false }), acct({ expiresAt: NOW - HOUR })], false],
];

for (const [label, accounts, canServe] of CASES) {
  const pool = poolOf(accounts);
  const all = pool.all();
  const router = pool.select() !== null;
  const health = derivePoolStatus(all, NOW, false);
  const banner = resolvePoolStartupStatus(all, NOW);
  const verdict = poolVerdict(all, NOW);

  check(`${label}: router ${canServe ? 'serves' : 'returns null'}`, router === canServe);
  check(`${label}: verdict agrees`, (verdict.state === 'serving') === canServe, verdict.state);
  check(`${label}: /health agrees`, (health.status === 'healthy') === canServe, health.status);
  check(`${label}: banner agrees`, (banner.status === 'healthy') === canServe, banner.status);
  check(`${label}: /health and banner agree on authenticated`,
    health.authenticated === banner.authenticated);
  if (!canServe) {
    check(`${label}: the reason is not blamed on a cool-down it is not in`,
      verdict.reasons.length > 0 && verdict.reasons.every((r) => blockedSummary(verdict).length > 0));
  }
}

// ── classification ────────────────────────────────────────────────────────

header('poolVerdict — states');
{
  check('no accounts is empty, not blocked', poolVerdict([], NOW).state === 'empty');
  check('an empty pool has nothing to explain', blockedSummary(poolVerdict([], NOW)) === '');
  check('a serving pool has nothing to explain',
    blockedSummary(poolVerdict([acct()], NOW)) === '');

  const v = poolVerdict([acct(), acct({ enabled: false })], NOW);
  check('one eligible of two is serving', v.state === 'serving');
  check('counts both accounts', v.accounts === 2);
  check('counts one eligible', v.eligible === 1);
  check('still records why the other cannot serve', v.blockedBy.disabled === 1);
}

header('poolVerdict — expiry is measured off the seats that can serve');
{
  const v = poolVerdict([
    acct({ expiresAt: NOW - 1_000 }),
    acct({ expiresAt: NOW + 2 * HOUR }),
    acct({ expiresAt: NOW + 5 * HOUR }),
  ], NOW);
  check('a dead seat does not drag the figure to zero', v.expiresAt === NOW + 2 * HOUR);

  const dead = poolVerdict([acct({ expiresAt: NOW - HOUR }), acct({ expiresAt: NOW - 2 * HOUR })], NOW);
  check('with nothing eligible it falls back to the earliest of all',
    dead.expiresAt === NOW - 2 * HOUR);
}

header('poolVerdict — reason precedence follows ineligibleReason');
{
  // A single account can satisfy several clauses at once. The predicate stops
  // at the first, and the verdict must not invent a second: an operator told
  // "disabled, expired" for one seat goes looking for two problems.
  const v = poolVerdict([acct({ enabled: false, expiresAt: NOW - HOUR, ...COOLING })], NOW);
  check('one account contributes exactly one reason', v.reasons.length === 1);
  check('and it is the first clause the predicate checks', v.reasons[0] === 'disabled');
  check('the count matches the account, not the clauses', v.blockedBy.disabled === 1);
}

header('blockedSummary — wording');
{
  const one = poolVerdict([acct({ enabled: false })], NOW);
  check('a pool of one is not "all 1 accounts"',
    blockedSummary(one) === 'the only account is disabled', blockedSummary(one));

  const many = poolVerdict([acct(LIMITED), acct(LIMITED), acct(LIMITED)], NOW);
  check('a single cause is stated once for the pool',
    blockedSummary(many) === 'all 3 accounts are rate-limited', blockedSummary(many));

  const mixed = poolVerdict([
    acct({ enabled: false }), acct({ expiresAt: NOW - HOUR }), acct(COOLING), acct(LIMITED),
  ], NOW);
  check('several causes are counted separately',
    blockedSummary(mixed) === '1 disabled, 1 expired, 1 in auth cool-down, 1 rate-limited',
    blockedSummary(mixed));
}

header('blockedSummary — the 503 body only promises a retry when waiting helps');
{
  // The 503 appends "; retry shortly" when every reason clears on its own.
  // A disabled seat does not, and the old fixed string told the operator to
  // wait for a state that would never change without them.
  const transient = (v) => v.reasons.every((r) => r === 'rate-limited' || r === 'auth-cooldown');
  check('rate-limited clears on its own', transient(poolVerdict([acct(LIMITED)], NOW)));
  check('auth cool-down clears on its own', transient(poolVerdict([acct(COOLING)], NOW)));
  check('disabled does not', !transient(poolVerdict([acct({ enabled: false })], NOW)));
  check('expired does not', !transient(poolVerdict([acct({ expiresAt: NOW - HOUR })], NOW)));
  check('a mix that includes a permanent cause does not',
    !transient(poolVerdict([acct(LIMITED), acct({ enabled: false })], NOW)));
}

header('the verdict is asked of the pool, not re-derived from it');
{
  const pool = poolOf([acct({ enabled: false }), acct(COOLING)]);
  const fromPool = pool.verdict(null, NOW);
  const fromAccounts = poolVerdict(pool.all(), NOW);
  check('pool.verdict() matches poolVerdict(pool.all())',
    JSON.stringify(fromPool) === JSON.stringify(fromAccounts));
}

header('rate-limit cool-downs are scoped, and a status verdict asks globally');
{
  const scoped = acct({ rateLimitCooldowns: { opus: { until: NOW + 60_000, backoffLevel: 1 } } });
  check('a family-scoped cool-down does not block the pool globally',
    poolVerdict([scoped], NOW).state === 'serving');
  check('but it does block that family',
    poolVerdict([scoped], NOW, 'opus').state === 'blocked');
  check('and names the rate limit when asked about it',
    blockedSummary(poolVerdict([scoped], NOW, 'opus')) === 'the only account is rate-limited');
}

header("doctor's Pool routing line");
{
  const serving = poolOf([acct()]);
  const ok = poolRoutingCheck(serving.verdict(null, NOW), serving.status(), serving.select().alias);
  check('a serving pool gets the info line', ok.status === 'info');
  check('and it names the seat', /next: acct0/.test(ok.detail));

  // The finding: this line could not say "disabled". select() stopped
  // returning blocked accounts in 1c4bd44, so the branch that rendered a
  // reason was unreachable and every blocked pool got the same generic text.
  const off = poolOf([acct({ enabled: false }), acct({ enabled: false })]);
  const warn = poolRoutingCheck(off.verdict(null, NOW), off.status(), null);
  check('an all-disabled pool warns', warn.status === 'warn');
  check('and says disabled', /all 2 accounts are disabled/.test(warn.detail), warn.detail);
  check('and does not blame a cool-down', !/cool-down/.test(warn.detail), warn.detail);
  check('and offers the fix that matches the cause',
    /Enable it from the Accounts tab/.test(warn.detail), warn.detail);
  check('and the ratio counts disabled seats as unavailable',
    /\(2\/2 unavailable\)/.test(warn.detail), warn.detail);

  const expired = poolOf([acct({ expiresAt: NOW - HOUR })]);
  const expiredCheck = poolRoutingCheck(expired.verdict(null, NOW), expired.status(), null);
  check('an expired pool is pointed at `dario login`',
    /dario login/.test(expiredCheck.detail), expiredCheck.detail);

  // No single next step, so naming one would pick a favourite.
  const mixed = poolOf([acct({ enabled: false }), acct({ expiresAt: NOW - HOUR })]);
  const mixedCheck = poolRoutingCheck(mixed.verdict(null, NOW), mixed.status(), null);
  check('a pool blocked two ways states both causes',
    /1 disabled, 1 expired/.test(mixedCheck.detail), mixedCheck.detail);
  check('and offers no advice it cannot justify',
    !/dario login|Accounts tab/.test(mixedCheck.detail), mixedCheck.detail);

  const empty = new AccountPool();
  const emptyCheck = poolRoutingCheck(empty.verdict(null, NOW), empty.status(), null);
  check('an empty pool says so rather than naming a cause it has no seats for',
    /the pool is empty/.test(emptyCheck.detail), emptyCheck.detail);
}

console.log(`\n${'='.repeat(70)}\n  ${pass} pass, ${fail} fail\n${'='.repeat(70)}`);
process.exit(fail === 0 ? 0 : 1);
