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
  pool.markRejected('alpha', { ...EMPTY_SNAPSHOT }, 'sonnet', 5_000, now);
  const alpha = pool.get('alpha');
  check('Sonnet sees alpha cooling', isInRateLimitCooldown(alpha, 'sonnet', now + 1));
  check('Opus remains eligible on alpha', !isInRateLimitCooldown(alpha, 'opus', now + 1));
  check('Sonnet routes around alpha', pool.select('sonnet')?.alias === 'beta');
  check('Opus can still use alpha', pool.select('opus')?.alias === 'alpha');

  const firstDeadline = alpha.rateLimitCooldowns.sonnet.until;
  pool.markRejected('alpha', { ...EMPTY_SNAPSHOT }, 'sonnet', null, now + 100);
  check('a concurrent 429 reuses the same cooldown window', alpha.rateLimitCooldowns.sonnet.until === firstDeadline);
  check('a concurrent 429 does not escalate backoff', alpha.rateLimitCooldowns.sonnet.backoffLevel === 1);

  alpha.rateLimitCooldowns.sonnet.until = Date.now() - 1;
  check('alpha re-enters rotation after cooldown', pool.select('sonnet')?.alias === 'alpha');
  check('expired rejection status is cleared', alpha.rateLimit.status !== 'rejected');
  const secondFailureAt = Date.now();
  pool.markRejected('alpha', { ...EMPTY_SNAPSHOT }, 'sonnet', null, secondFailureAt);
  check('a later 429 escalates to the next cooldown rung',
    alpha.rateLimitCooldowns.sonnet.until === secondFailureAt + 2_000
      && alpha.rateLimitCooldowns.sonnet.backoffLevel === 2);
}

header('known-unavailable accounts never leak through fallback');
{
  const pool = new AccountPool('round-robin');
  add(pool, 'expired', 'Pro');
  pool.updateTokens('expired', 'token', 'refresh', Date.now() - 1);
  check('normal select returns null', pool.select('sonnet') === null);
  check('failover select returns null', pool.selectExcluding(new Set(), 'sonnet') === null);
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

console.log(`\n${'='.repeat(70)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(70)}`);
process.exit(fail > 0 ? 1 : 0);
