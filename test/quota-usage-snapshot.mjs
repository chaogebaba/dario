#!/usr/bin/env bun
// Utilization reporting — "0%" must mean measured-zero, never no-idea.
//
// dario learns an account's 5h / 7d consumption only as a side effect of
// proxying a response that carries `anthropic-ratelimit-unified-*` headers.
// Two ways that produced a confidently wrong number on screen:
//
//   1. A response with NO rate-limit headers — a 401 on an expired token, a
//      400 on a bad body, a 502 from the edge — parses to an all-zero
//      snapshot, and the pool stored it. An account measured at 60% dropped
//      to 0% on the first upstream error and stayed there until the next
//      successful call.
//   2. An account the pool has never had a response for starts on
//      EMPTY_SNAPSHOT, whose zeros are indistinguishable at the /accounts
//      boundary from a genuinely idle account. Restart the proxy and every
//      seat reports "0% used" no matter how much quota is actually gone.
//
// Both were reported from a live machine: a pool of one whose refresh token
// had died showed `util5h 0%  util7d 0%  status unknown` while the operator
// knew they had spent a real fraction of the window. The third contract here
// covers the banner that accompanied it — a pool holding nothing but expired
// tokens announced `OAuth: healthy (expires in 0h 0m)` one line below
// `Startup refresh failed for login: invalid_grant`.

import {
  AccountPool,
  EMPTY_SNAPSHOT,
  parseRateLimits,
  hasRateLimitHeaders,
} from '../dist/pool.js';
import { formatPoolStartupLine, resolvePoolStartupStatus } from '../dist/proxy.js';

let pass = 0;
let fail = 0;
function check(label, cond, ...rest) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`, ...rest); }
}
function header(name) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}

const h = (map) => {
  const out = new Headers();
  for (const [k, v] of Object.entries(map)) out.set(k, v);
  return out;
};

/** A response the way Anthropic returns it once the request was accounted for. */
const MEASURED = {
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.62',
  'anthropic-ratelimit-unified-7d-utilization': '0.31',
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-reset': '1786900000',
};

/** What a 401 / 400 / 502 actually looks like: no accounting headers at all. */
const BARE = {
  'content-type': 'application/json',
  'request-id': 'req_abc123',
};

const addAccount = (pool, alias) => pool.add(alias, {
  accessToken: 'tok', refreshToken: 'ref',
  expiresAt: Date.now() + 3600_000,
  deviceId: 'dev', accountUuid: 'uuid',
});

// ======================================================================
header('hasRateLimitHeaders — does this response say anything about quota?');
{
  check('a fully-headered response is measured', hasRateLimitHeaders(h(MEASURED)) === true);
  check('a bare error response is not', hasRateLimitHeaders(h(BARE)) === false);
  check('a completely empty header set is not', hasRateLimitHeaders(h({})) === false);

  // The status header is the usual sentinel, but a response carrying only a
  // utilization figure still told us something real.
  check('utilization alone counts as measured',
    hasRateLimitHeaders(h({ 'anthropic-ratelimit-unified-5h-utilization': '0.4' })) === true);
  check('the 7d bucket alone counts as measured',
    hasRateLimitHeaders(h({ 'anthropic-ratelimit-unified-7d-utilization': '0.4' })) === true);

  // Unrelated Anthropic headers must not be mistaken for accounting.
  check('an unrelated anthropic- header does not count',
    hasRateLimitHeaders(h({ 'anthropic-organization-id': 'org_1' })) === false);
}

// ======================================================================
header('parseRateLimits — the snapshot says whether it is a measurement');
{
  const real = parseRateLimits(h(MEASURED));
  check('a real response parses as measured', real.measured === true);
  check('and carries the figures', real.util5h === 0.62 && real.util7d === 0.31);
  check('with a timestamp', real.updatedAt > 0);

  const bare = parseRateLimits(h(BARE));
  check('a bare response parses as unmeasured', bare.measured === false);
  // The zeros are still there — that is exactly why the flag has to be.
  check('and its zeros look identical to a real 0%', bare.util5h === 0 && bare.util7d === 0);

  // A genuinely idle account: headers present, values zero. This must NOT be
  // confused with the bare case — it is the one reading that legitimately
  // renders as 0%.
  const idle = parseRateLimits(h({
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': '0',
    'anthropic-ratelimit-unified-7d-utilization': '0',
  }));
  check('a measured 0% is measured', idle.measured === true && idle.util5h === 0);

  check('EMPTY_SNAPSHOT is unmeasured', EMPTY_SNAPSHOT.measured === false);
  check('EMPTY_SNAPSHOT has no timestamp', EMPTY_SNAPSHOT.updatedAt === 0);
}

// ======================================================================
header('updateRateLimits — an unheadered response must not erase a measurement');
{
  const pool = new AccountPool();
  addAccount(pool, 'a');

  pool.updateRateLimits('a', parseRateLimits(h(MEASURED)));
  check('a measured response is stored', pool.get('a').rateLimit.util5h === 0.62);
  const measuredAt = pool.get('a').rateLimit.updatedAt;

  // The regression. Before the fix this dropped util5h to 0.
  pool.updateRateLimits('a', parseRateLimits(h(BARE)));
  check('a bare response leaves util5h alone', pool.get('a').rateLimit.util5h === 0.62);
  check('and util7d', pool.get('a').rateLimit.util7d === 0.31);
  check('and does not restamp the measurement time',
    pool.get('a').rateLimit.updatedAt === measuredAt);
  check('and does not fabricate a claim',
    pool.get('a').rateLimit.claim === 'five_hour');

  // It is still a request against this account — the counter drives
  // fill-first tie-breaking, so dropping it would skew routing.
  check('but it still counts as a request', pool.get('a').requestCount === 2);

  // A later real response wins, including a genuine drop after a window reset.
  pool.updateRateLimits('a', parseRateLimits(h({
    ...MEASURED,
    'anthropic-ratelimit-unified-5h-utilization': '0.02',
  })));
  check('a later measured response does replace it', pool.get('a').rateLimit.util5h === 0.02);
}

// ======================================================================
header('markRejected — a 429 with no headers still routes away, keeps the numbers');
{
  const pool = new AccountPool();
  addAccount(pool, 'a');
  pool.updateRateLimits('a', parseRateLimits(h(MEASURED)));

  pool.markRejected('a', parseRateLimits(h(BARE)));
  check('status flips to rejected', pool.get('a').rateLimit.status === 'rejected');
  check('utilization survives the rejection', pool.get('a').rateLimit.util5h === 0.62);
  // Zeroing here was the worse half of the bug: computeHeadroom would then
  // rank the exhausted account as the emptiest seat in the pool.
  check('so the exhausted account does not look empty',
    1 - Math.max(pool.get('a').rateLimit.util5h, pool.get('a').rateLimit.util7d) < 0.5);

  // A 429 that DOES carry headers still replaces them — that is the reading
  // taken at the moment of exhaustion.
  pool.markRejected('a', parseRateLimits(h({
    ...MEASURED,
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-5h-utilization': '1',
  })));
  check('a headered 429 updates the figures', pool.get('a').rateLimit.util5h === 1);
  check('and is still marked rejected', pool.get('a').rateLimit.status === 'rejected');
}

// ======================================================================
header('a never-used account reports "no idea", not "0% used"');
{
  const pool = new AccountPool();
  addAccount(pool, 'fresh');
  const snap = pool.get('fresh').rateLimit;

  check('starts unmeasured', snap.measured === false);
  check('with updatedAt 0 — the field /accounts publishes as lastObservedAt',
    snap.updatedAt === 0);
  check('status is unknown, not allowed', snap.status === 'unknown');

  // The whole point: a consumer reading only util5h cannot tell these apart,
  // so the timestamp has to travel with it.
  const idlePool = new AccountPool();
  addAccount(idlePool, 'idle');
  idlePool.updateRateLimits('idle', parseRateLimits(h({
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': '0',
    'anthropic-ratelimit-unified-7d-utilization': '0',
  })));
  const idle = idlePool.get('idle').rateLimit;

  check('a measured-idle account has the same zeros', idle.util5h === snap.util5h);
  check('but a nonzero lastObservedAt distinguishes it', idle.updatedAt > 0 && snap.updatedAt === 0);
}

// ======================================================================
header('resolvePoolStartupStatus — the banner cannot claim healthy on dead tokens');
{
  const NOW = 1_786_872_000_000;

  // The live report: a pool of one whose token expired three months ago,
  // whose refresh returned invalid_grant, printing "healthy (expires in 0h 0m)".
  const dead = resolvePoolStartupStatus([{ expiresAt: NOW - 88 * 86_400_000 }], NOW);
  check('an all-expired pool is not authenticated', dead.authenticated === false);
  check('and does not say healthy', dead.status !== 'healthy');
  check('and says expired', dead.status === 'expired');
  check('and points at the fix', /dario login/.test(dead.expiresIn));
  check('and never renders as 0h 0m', !/0h 0m/.test(dead.expiresIn));
  // The banner interpolates `OAuth: ${status} — ${expiresIn}`, so an
  // expiresIn that repeats the status reads "expired — expired — run …".
  check('and does not repeat the status word', !/expired/.test(dead.expiresIn));

  const live = resolvePoolStartupStatus([{ expiresAt: NOW + 3 * 3600_000 + 25 * 60_000 }], NOW);
  check('a live pool is authenticated', live.authenticated === true);
  check('and healthy', live.status === 'healthy');
  check('and reports the remaining time', live.expiresIn === '3h 25m');

  // A token inside the 30s eligibility window select() uses is not usable.
  const marginal = resolvePoolStartupStatus([{ expiresAt: NOW + 10_000 }], NOW);
  check('a token expiring inside the select() window counts as expired',
    marginal.authenticated === false);

  // Mixed pool: one dead seat must not drag the figure to zero, and must not
  // stop the proxy reporting the healthy seat it will actually route to.
  const mixed = resolvePoolStartupStatus([
    { expiresAt: NOW - 1000 },
    { expiresAt: NOW + 2 * 3600_000 },
    { expiresAt: NOW + 5 * 3600_000 },
  ], NOW);
  check('a mixed pool is healthy', mixed.authenticated === true);
  check('and reports the soonest LIVE expiry, not the dead one',
    mixed.expiresIn === '2h 0m');

  const empty = resolvePoolStartupStatus([], NOW);
  check('an empty pool is not authenticated', empty.authenticated === false);
  check('and has no expiry to report', empty.expiresAt === 0);
}

header('formatPoolStartupLine — reports the effective routing policy');
{
  check('round-robin is not mislabeled as headroom routing',
    formatPoolStartupLine(2, 'round-robin', true).includes('round-robin'));
  check('session affinity state is explicit',
    formatPoolStartupLine(2, 'fill-first', false).includes('session affinity disabled'));
}

console.log(`\n${'='.repeat(70)}\n  ${pass} pass, ${fail} fail\n${'='.repeat(70)}`);
process.exit(fail === 0 ? 0 : 1);
