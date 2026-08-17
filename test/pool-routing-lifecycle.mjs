#!/usr/bin/env bun
// Round-robin/session-affinity lifecycle contracts mirrored from CLIProxyAPI.

import {
  AccountPool,
  EMPTY_SNAPSHOT,
  isInRateLimitCooldown,
} from '../dist/pool.js';

let pass = 0;
let fail = 0;
function check(label, condition) {
  if (condition) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`); }
}
function header(label) {
  console.log(`\n${'='.repeat(70)}\n  ${label}\n${'='.repeat(70)}`);
}
function add(pool, alias, plan) {
  pool.add(alias, {
    accessToken: `token-${alias}`,
    refreshToken: `refresh-${alias}`,
    expiresAt: Date.now() + 3_600_000,
    deviceId: `device-${alias}`,
    accountUuid: `account-${alias}`,
  });
  pool.updatePlan(alias, plan);
  pool.updateRateLimits(alias, {
    ...EMPTY_SNAPSHOT,
    status: 'allowed',
    measured: true,
    updatedAt: Date.now(),
  });
}

header('round-robin cursors are model-family scoped');
{
  const pool = new AccountPool('round-robin', { sessionAffinity: false });
  add(pool, 'a-pro', 'Pro');
  add(pool, 'b-max', 'Max');
  check('first Sonnet session uses a-pro', pool.select('sonnet')?.alias === 'a-pro');
  check('Fable independently uses the Max seat', pool.select('fable')?.alias === 'b-max');
  check('second Sonnet session continues to b-max', pool.select('sonnet')?.alias === 'b-max');
}

header('sticky bindings are model-family scoped');
{
  const pool = new AccountPool('round-robin', { sessionAffinity: true });
  add(pool, 'a-pro', 'Pro');
  add(pool, 'b-max', 'Max');
  const key = 'header:conversation-1';
  check('Sonnet binds to a-pro', pool.selectSticky(key, 'sonnet')?.alias === 'a-pro');
  check('same session Fable binds separately to b-max', pool.selectSticky(key, 'fable')?.alias === 'b-max');
  check('returning to Sonnet preserves its original binding', pool.selectSticky(key, 'sonnet')?.alias === 'a-pro');
  check('two model-scoped bindings are observable', pool.stickyCount() === 2);
}

header('429 cooldown is scoped, bounded, and recoverable');
{
  const pool = new AccountPool('round-robin');
  add(pool, 'alpha', 'Pro');
  add(pool, 'beta', 'Pro');
  const now = Date.now();
  pool.markRejected('alpha', {
    ...EMPTY_SNAPSHOT,
    util5h: 0.2,
    util7d: 0.2,
    perModel7d: { sonnet: 1 },
    measured: true,
  }, 'sonnet', 5_000, now);
  const alpha = pool.get('alpha');
  check('Sonnet sees alpha cooling', isInRateLimitCooldown(alpha, 'sonnet', now + 1));
  check('Opus remains eligible on alpha', !isInRateLimitCooldown(alpha, 'opus', now + 1));
  check('Sonnet routes around alpha', pool.select('sonnet')?.alias === 'beta');
  check('Opus can still use alpha', pool.select('opus')?.alias === 'alpha');

  const firstDeadline = alpha.rateLimitCooldowns.sonnet.until;
  pool.markRejected('alpha', {
    ...EMPTY_SNAPSHOT,
    util5h: 0.2,
    util7d: 0.2,
    perModel7d: { sonnet: 1 },
    measured: true,
  }, 'sonnet', null, now + 100);
  check('a concurrent 429 reuses the same cooldown window', alpha.rateLimitCooldowns.sonnet.until === firstDeadline);
  check('a concurrent 429 does not escalate backoff', alpha.rateLimitCooldowns.sonnet.backoffLevel === 1);

  pool.markRejected('beta', {
    ...EMPTY_SNAPSHOT,
    util5h: 0.2,
    util7d: 0.2,
    perModel7d: { sonnet: 1 },
    measured: true,
  }, 'sonnet', null, now);
  const headerlessDeadline = pool.get('beta').rateLimitCooldowns.sonnet.until;
  pool.markRejected('beta', {
    ...EMPTY_SNAPSHOT,
    util5h: 0.2,
    util7d: 0.2,
    perModel7d: { sonnet: 1 },
    measured: true,
  }, 'sonnet', null, now + 100);
  check('a headerless concurrent 429 preserves the original deadline',
    pool.get('beta').rateLimitCooldowns.sonnet.until === headerlessDeadline);

  alpha.rateLimitCooldowns.sonnet.until = Date.now() - 1;
  check('alpha re-enters rotation after cooldown', pool.select('sonnet')?.alias === 'alpha');
  check('expired rejection status is cleared', alpha.rateLimit.status !== 'rejected');
  const secondFailureAt = Date.now();
  pool.markRejected('alpha', {
    ...EMPTY_SNAPSHOT,
    util5h: 0.2,
    util7d: 0.2,
    perModel7d: { sonnet: 1 },
    measured: true,
  }, 'sonnet', null, secondFailureAt);
  check('a later 429 escalates to the next cooldown rung',
    alpha.rateLimitCooldowns.sonnet.until === secondFailureAt + 2_000
      && alpha.rateLimitCooldowns.sonnet.backoffLevel === 2);
}

header('unified 429 cooldown applies across models and honors reset');
{
  const pool = new AccountPool('round-robin');
  add(pool, 'alpha', 'Pro');
  const now = Date.now();
  const reset = Math.floor((now + 60 * 60_000) / 1000);
  const requestStartedAtEpoch = pool.get('alpha').rejectionEpoch;
  pool.markRejected('alpha', {
    ...EMPTY_SNAPSHOT,
    status: 'rejected',
    util5h: 1,
    util7d: 0.5,
    reset,
    measured: true,
  }, 'sonnet', null, now);
  const alpha = pool.get('alpha');
  check('unified exhaustion creates a credential-wide cooldown', Boolean(alpha.rateLimitCooldowns['*']));
  check('another model cannot bypass unified exhaustion', isInRateLimitCooldown(alpha, 'opus', now + 1));
  check('reset header controls the deadline when Retry-After is absent',
    alpha.rateLimitCooldowns['*'].until === reset * 1000);
  check('account remains unavailable beyond the exponential fallback',
    isInRateLimitCooldown(alpha, 'sonnet', now + 30 * 60_000));
  check('the rejected request is included in account totals', alpha.requestCount === 2);

  pool.updateRateLimits('alpha', {
    ...EMPTY_SNAPSHOT,
    status: 'allowed',
    measured: true,
    updatedAt: now + 1,
  }, 'sonnet', true, requestStartedAtEpoch);
  check('a success dispatched before the rejection cannot clear its cooldown',
    isInRateLimitCooldown(alpha, 'sonnet', now + 2)
      && Boolean(alpha.rateLimitCooldowns['*']));

  pool.updateRateLimits('alpha', {
    ...EMPTY_SNAPSHOT,
    status: 'allowed',
    measured: true,
    updatedAt: now + 2,
  }, 'sonnet', true, alpha.rejectionEpoch);
  check('a successful retry dispatched after rejection clears cooldown state',
    !isInRateLimitCooldown(alpha, 'sonnet', now + 2)
      && !alpha.rateLimitCooldowns['*']);
}

header('known-unavailable accounts never leak through fallback');
{
  const pool = new AccountPool('round-robin');
  add(pool, 'expired', 'Pro');
  pool.updateTokens('expired', 'token', 'refresh', Date.now() - 1);
  check('normal select returns null', pool.select('sonnet') === null);
  check('failover select returns null', pool.selectExcluding(new Set(), 'sonnet') === null);
}

header('credential replacement invalidates alias-based affinity');
{
  const pool = new AccountPool('round-robin', { sessionAffinity: true });
  add(pool, 'alpha', 'Pro');
  const key = 'header:replacement';
  check('original credential receives a binding', pool.selectSticky(key, 'sonnet')?.alias === 'alpha');
  pool.add('alpha', {
    accessToken: 'replacement-token',
    refreshToken: 'replacement-refresh',
    expiresAt: Date.now() + 3_600_000,
    deviceId: 'replacement-device',
    accountUuid: 'replacement-account',
  });
  check('replacement credential does not inherit the old binding', pool.stickyAliasFor(key, 'sonnet') === null);
}

header('completed quota windows discard stale utilization');
{
  const pool = new AccountPool('round-robin');
  add(pool, 'alpha', 'Pro');
  const past = Date.now() - 2_000;
  pool.markRejected('alpha', {
    ...EMPTY_SNAPSHOT,
    status: 'rejected',
    util5h: 1,
    util7d: 1,
    reset: Math.floor((Date.now() - 1_000) / 1000),
    measured: true,
    updatedAt: past,
  }, 'sonnet', 1_000, past);
  check('account re-enters after both cooldown and quota reset', pool.select('sonnet')?.alias === 'alpha');
  check('stale utilization is no longer treated as current', pool.get('alpha').rateLimit.measured === false);
}

header('failed affinity binding is compare-and-released');
{
  const pool = new AccountPool('round-robin', { sessionAffinity: true });
  add(pool, 'alpha', 'Pro');
  add(pool, 'beta', 'Pro');
  const key = 'header:conversation-2';
  check('initial binding uses alpha', pool.selectSticky(key, 'sonnet')?.alias === 'alpha');
  pool.releaseSticky(key, 'sonnet', 'beta');
  check('wrong alias cannot release binding', pool.stickyAliasFor(key, 'sonnet') === 'alpha');
  pool.releaseSticky(key, 'sonnet', 'alpha');
  check('matching failed alias releases binding', pool.stickyAliasFor(key, 'sonnet') === null);
  check('next selection can establish a new binding', pool.selectSticky(key, 'sonnet')?.alias === 'beta');
}

header('affinity leases are safe under concurrent completion ordering');
{
  const pool = new AccountPool('round-robin', { sessionAffinity: true });
  add(pool, 'alpha', 'Pro');
  add(pool, 'beta', 'Pro');
  const key = 'header:concurrent-conversation';
  const older = pool.selectStickyWithLease(key, 'sonnet');
  const newer = pool.selectStickyWithLease(key, 'sonnet');
  pool.confirmSticky(newer.lease);
  pool.releaseStickyLease(older.lease);
  check('an older failure cannot delete a newer successful binding',
    pool.stickyAliasFor(key, 'sonnet') === 'alpha');

  const olderSuccess = pool.selectStickyWithLease(key, 'sonnet');
  const newerFailure = pool.selectStickyWithLease(key, 'sonnet');
  pool.releaseStickyLease(newerFailure.lease);
  pool.confirmSticky(olderSuccess.lease);
  check('an older in-flight success restores a binding after a newer failure',
    pool.stickyAliasFor(key, 'sonnet') === 'alpha');
}

console.log(`\n${'='.repeat(70)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(70)}`);
process.exit(fail > 0 ? 1 : 0);
