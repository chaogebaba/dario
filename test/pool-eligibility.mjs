#!/usr/bin/env bun
// Pool eligibility — the predicate `select()` filters on, and the invariant
// every diagnostic that reports "what will serve next" depends on.
//
// `select()` does not return only eligible accounts. When nothing is
// eligible it falls back to the earliest-reset account, and failing that to
// the least-used one, so the caller gets *something* rather than null. That
// is deliberate — an unmeasured account has to be tried before it can be
// measured — but it means a non-null return is not a promise that the
// account can serve.
//
// `dario doctor` read it as one. On a pool of one whose token had expired
// three months earlier it printed:
//
//   [WARN]  Pool             pool of 1, 1 expired
//   [INFO]  Pool routing     next: login  (max-headroom select; 0/1 healthy)
//
// naming a seat that answers every request with a 401. `ineligibleReason`
// is the router's own filter, extracted so a diagnostic asks the same
// question rather than re-deriving a subtly different one.

import { AccountPool, EMPTY_SNAPSHOT, ineligibleReason, authCooldownMs } from '../dist/pool.js';

let pass = 0;
let fail = 0;
function check(label, cond, ...rest) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`, ...rest); }
}
function header(name) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}

const NOW = 1_786_872_000_000;

/** A pool account literal — only the fields ineligibleReason reads. */
const acct = (over = {}) => ({
  alias: 'a',
  expiresAt: NOW + 3600_000,
  rateLimit: { ...EMPTY_SNAPSHOT },
  consecutiveAuthFailures: 0,
  ...over,
});

// ======================================================================
header('ineligibleReason — one cause per state');
{
  check('a live, unrejected, uncooled account is eligible',
    ineligibleReason(acct(), NOW) === null);

  check('an expired token is ineligible',
    ineligibleReason(acct({ expiresAt: NOW - 1 }), NOW) === 'expired');

  // The live report: expired 88 days ago, still returned by select().
  check('a long-dead token is ineligible',
    ineligibleReason(acct({ expiresAt: NOW - 88 * 86_400_000 }), NOW) === 'expired');

  // 30s of slack — a token that expires mid-flight is no use.
  check('a token expiring inside the 30s window is ineligible',
    ineligibleReason(acct({ expiresAt: NOW + 10_000 }), NOW) === 'expired');
  check('a token just outside the 30s window is eligible',
    ineligibleReason(acct({ expiresAt: NOW + 31_000 }), NOW) === null);

  check('a rejected (429) account is ineligible',
    ineligibleReason(acct({ rateLimit: { ...EMPTY_SNAPSHOT, status: 'rejected' } }), NOW) === 'rate-limited');

  check('an account inside its auth cool-down is ineligible',
    ineligibleReason(acct({ lastAuthFailureAt: NOW - 1000, consecutiveAuthFailures: 1 }), NOW) === 'auth-cooldown');

  check('and eligible again once the cool-down lapses',
    ineligibleReason(acct({
      lastAuthFailureAt: NOW - authCooldownMs(1) - 1,
      consecutiveAuthFailures: 1,
    }), NOW) === null);

  // An expired token provokes the 401 that starts the cool-down, so both
  // are true at once. Reporting the cool-down would send the operator
  // looking for a transient blip instead of at the credential they must
  // replace.
  const both = acct({
    expiresAt: NOW - 1,
    lastAuthFailureAt: NOW - 1000,
    consecutiveAuthFailures: 1,
  });
  check('expiry outranks the cool-down it caused', ineligibleReason(both, NOW) === 'expired');

  check('defaults to now when no clock is passed',
    ineligibleReason(acct({ expiresAt: Date.now() - 1 })) === 'expired');
}

// ======================================================================
header('select() still falls back — a non-null return is not a promise');
{
  const pool = new AccountPool();
  pool.add('dead', {
    accessToken: 't', refreshToken: 'r',
    expiresAt: Date.now() - 88 * 86_400_000,
    deviceId: 'd', accountUuid: 'u',
  });

  const next = pool.select();
  // If this ever changes to null, doctor's guard becomes dead code rather
  // than wrong — but the routing change would be the news, so pin it.
  check('select() returns the expired account anyway', next?.alias === 'dead');
  check('and the predicate flags it', ineligibleReason(next) === 'expired');
  check('so the two disagree — which is the whole point of asking',
    next !== null && ineligibleReason(next) !== null);

  const st = pool.status();
  check('status() counts it as unhealthy', st.healthy === 0 && st.exhausted === 1);
  // bestAccount is documented as "what select() returns", so it names the
  // same seat. Anything rendering it for humans needs the predicate too.
  check('bestAccount names it regardless', st.bestAccount === 'dead');
}

// ======================================================================
header('select() prefers an eligible seat over a dead one');
{
  const pool = new AccountPool();
  pool.add('dead', {
    accessToken: 't', refreshToken: 'r', expiresAt: Date.now() - 1000,
    deviceId: 'd', accountUuid: 'u',
  });
  pool.add('live', {
    accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000,
    deviceId: 'd', accountUuid: 'u',
  });

  const next = pool.select();
  check('picks the live seat', next?.alias === 'live');
  check('and the predicate agrees it can serve', ineligibleReason(next) === null);
  check('healthy count reflects only the live seat', pool.status().healthy === 1);
}

console.log(`\n${'='.repeat(70)}\n  ${pass} pass, ${fail} fail\n${'='.repeat(70)}`);
process.exit(fail === 0 ? 0 : 1);
