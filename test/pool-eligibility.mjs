#!/usr/bin/env bun
// Pool eligibility — the predicate `select()` filters on, and the invariant
// every diagnostic that reports "what will serve next" depends on.
//
// Selection and diagnostics share one eligibility predicate. When every
// account is expired or cooling, selection returns null instead of dispatching
// a request that is already known to fail.

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
  rateLimitCooldowns: {},
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
    ineligibleReason(acct({
      rateLimit: { ...EMPTY_SNAPSHOT, status: 'rejected' },
      rateLimitCooldowns: { '*': { until: NOW + 1000, backoffLevel: 1 } },
    }), NOW) === 'rate-limited');

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
header('select() fails closed when every account is unavailable');
{
  const pool = new AccountPool();
  pool.add('dead', {
    accessToken: 't', refreshToken: 'r',
    expiresAt: Date.now() - 88 * 86_400_000,
    deviceId: 'd', accountUuid: 'u',
  });

  const next = pool.select();
  check('select() returns null for the expired-only pool', next === null);

  const st = pool.status();
  check('status() counts it as unhealthy', st.healthy === 0 && st.exhausted === 1);
  check('bestAccount truthfully reports none', st.bestAccount === 'none');
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
