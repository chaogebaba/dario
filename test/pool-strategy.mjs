#!/usr/bin/env bun
/**
 * test/pool-strategy.mjs
 *
 * Pool routing strategy. `headroom` (the default, and the only behaviour
 * before this feature) spreads new conversations to the seat with the most
 * slack; `fill-first` concentrates them on the alphabetically-first
 * eligible seat until it drains to the 2% floor, then spills to the next —
 * primary/backup semantics where alias naming picks the fill order.
 *
 * Covers:
 *   - resolvePoolStrategy: explicit wins, env fallback, invalid values
 *     fall through to the default, case/whitespace tolerance
 *   - default construction preserves headroom behaviour exactly
 *   - fill-first: picks the alphabetically-first seat even when a later
 *     seat has more headroom
 *   - fill-first: spills to the next alias at/below the 2% floor and
 *     returns when headroom recovers
 *   - fill-first: skips rejected / expired / auth-cooldown seats
 *   - fill-first: all seats at/below the floor falls back to max-headroom
 *   - fill-first: per-model 7d bucket joins the floor check
 *   - selectExcluding keeps fill order on failover
 *   - selectSticky: existing bindings win over fill order in both modes
 *
 * Runs in-process. No proxy, no OAuth, no network.
 */

import { AccountPool, computeStickyKey, resolvePoolStrategy, EMPTY_SNAPSHOT } from '../dist/pool.js';

let pass = 0;
let fail = 0;

function check(label, cond) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
}

function header(name) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}

// Helper — add an account with an initial snapshot
function addAccount(pool, alias, { util5h = 0, util7d = 0, perModel7d = {}, rejected = false, expiresInMs = 3600_000 } = {}) {
  pool.add(alias, {
    accessToken: `tok-${alias}`,
    refreshToken: `ref-${alias}`,
    expiresAt: Date.now() + expiresInMs,
    deviceId: `dev-${alias}`,
    accountUuid: `uuid-${alias}`,
  });
  pool.updateRateLimits(alias, {
    ...EMPTY_SNAPSHOT,
    util5h,
    util7d,
    perModel7d,
    status: rejected ? 'rejected' : 'ok',
    measured: true, updatedAt: Date.now(),
  });
  if (rejected) {
    pool.markRejected(alias, {
      ...EMPTY_SNAPSHOT,
      util5h, util7d, perModel7d,
      status: 'rejected',
      measured: true, updatedAt: Date.now(),
    });
  }
}

header('resolvePoolStrategy');
{
  check('default is headroom', resolvePoolStrategy(undefined, {}) === 'headroom');
  check('explicit fill-first wins', resolvePoolStrategy('fill-first', {}) === 'fill-first');
  check('explicit headroom wins over env', resolvePoolStrategy('headroom', { DARIO_POOL_STRATEGY: 'fill-first' }) === 'headroom');
  check('env fallback applies', resolvePoolStrategy(undefined, { DARIO_POOL_STRATEGY: 'fill-first' }) === 'fill-first');
  check('invalid explicit falls through to env', resolvePoolStrategy('nope', { DARIO_POOL_STRATEGY: 'fill-first' }) === 'fill-first');
  check('round-robin explicit wins over env', resolvePoolStrategy('round-robin', { DARIO_POOL_STRATEGY: 'fill-first' }) === 'round-robin');
  check('invalid everywhere falls back to headroom', resolvePoolStrategy('nope', { DARIO_POOL_STRATEGY: 'also-nope' }) === 'headroom');
  check('case and whitespace tolerated', resolvePoolStrategy('  Fill-First ', {}) === 'fill-first');
}

header('default construction preserves headroom behaviour');
{
  const pool = new AccountPool();
  addAccount(pool, 'a-main', { util5h: 0.6 });
  addAccount(pool, 'b-spill', { util5h: 0.1 });
  check('picks the max-headroom seat', pool.select()?.alias === 'b-spill');
}

header('fill-first concentrates on the first alias');
{
  const pool = new AccountPool('fill-first');
  addAccount(pool, 'b-spill', { util5h: 0.1 });
  addAccount(pool, 'a-main', { util5h: 0.6 });
  check('first alias wins despite worse headroom', pool.select()?.alias === 'a-main');
  check('insertion order is irrelevant', pool.select()?.alias === 'a-main');
}

header('fill-first spills at the floor and returns on recovery');
{
  const pool = new AccountPool('fill-first');
  addAccount(pool, 'a-main', { util5h: 0.99 });   // headroom 1% <= 2% floor
  addAccount(pool, 'b-spill', { util5h: 0.5 });
  check('spills to next alias at/below the floor', pool.select()?.alias === 'b-spill');

  pool.updateRateLimits('a-main', { ...EMPTY_SNAPSHOT, util5h: 0.3, status: 'ok', measured: true, updatedAt: Date.now() });
  check('returns to first alias when headroom recovers', pool.select()?.alias === 'a-main');
}

header('fill-first skips ineligible seats');
{
  const pool = new AccountPool('fill-first');
  addAccount(pool, 'a-rejected', { util5h: 0.1, rejected: true });
  addAccount(pool, 'b-expired', { util5h: 0.1, expiresInMs: 5_000 });
  addAccount(pool, 'c-cooldown', { util5h: 0.1 });
  addAccount(pool, 'd-healthy', { util5h: 0.4 });
  pool.markAuthFailure('c-cooldown');
  check('rejected/expired/cooldown seats are skipped', pool.select()?.alias === 'd-healthy');
}

header('fill-first with every seat at/below the floor');
{
  const pool = new AccountPool('fill-first');
  addAccount(pool, 'a-main', { util5h: 0.99 });
  addAccount(pool, 'b-spill', { util5h: 0.985 });
  check('falls back to max-headroom (least-drained)', pool.select()?.alias === 'b-spill');
}

header('fill-first honours per-model 7d buckets');
{
  const pool = new AccountPool('fill-first');
  addAccount(pool, 'a-main', { util5h: 0.2, perModel7d: { sonnet: 0.99 } });
  addAccount(pool, 'b-spill', { util5h: 0.5 });
  check('sonnet request spills off the sonnet-drained seat', pool.select('sonnet')?.alias === 'b-spill');
  check('opus request stays on the first seat', pool.select('opus')?.alias === 'a-main');
}

header('selectExcluding keeps fill order on failover');
{
  const pool = new AccountPool('fill-first');
  addAccount(pool, 'a-main', { util5h: 0.3 });
  addAccount(pool, 'b-next', { util5h: 0.6 });
  addAccount(pool, 'c-best-headroom', { util5h: 0.1 });
  const next = pool.selectExcluding(new Set(['a-main']));
  check('failover tries the next alias, not max-headroom', next?.alias === 'b-next');

  const headroomPool = new AccountPool();
  addAccount(headroomPool, 'a-main', { util5h: 0.3 });
  addAccount(headroomPool, 'b-next', { util5h: 0.6 });
  addAccount(headroomPool, 'c-best-headroom', { util5h: 0.1 });
  const hNext = headroomPool.selectExcluding(new Set(['a-main']));
  check('headroom mode failover unchanged (max-headroom)', hNext?.alias === 'c-best-headroom');
}

header('sticky bindings win over fill order in both modes');
{
  const key = computeStickyKey('same first user message');
  for (const strategy of ['headroom', 'fill-first']) {
    const pool = new AccountPool(strategy);
    addAccount(pool, 'a-main', { util5h: 0.3 });
    addAccount(pool, 'b-other', { util5h: 0.3 });
    pool.rebindSticky(key, 'b-other');
    check(`${strategy}: existing binding returned as-is`, pool.selectSticky(key)?.alias === 'b-other');
  }
}

header('round-robin with sticky hint avoids double-advance');
{
  // Simulate the proxy flow: pool.select() picks an account (the hint),
  // then selectSticky(key, family, now, hint) should use the hint for a new
  // binding instead of calling select() again (which double-advances the index).
  const pool = new AccountPool('round-robin', { sessionAffinity: true });
  addAccount(pool, 'alpha', { util5h: 0.3 });
  addAccount(pool, 'beta', { util5h: 0.3 });

  // First "request": proxy calls select() → gets alpha (sorted order idx=0)
  const hint1 = pool.select();
  check('rr hint1 is alpha', hint1?.alias === 'alpha');
  // Then selectSticky with hint → should bind to alpha (the hint), NOT call select() again
  const key1 = computeStickyKey('conversation one first message');
  const sticky1 = pool.selectSticky(key1, null, Date.now(), hint1);
  check('sticky uses hint (alpha) for new binding', sticky1?.alias === 'alpha');

  // Second "request" (new conversation): proxy calls select() → gets beta (idx=1)
  const hint2 = pool.select();
  check('rr hint2 is beta', hint2?.alias === 'beta');
  const key2 = computeStickyKey('conversation two first message');
  const sticky2 = pool.selectSticky(key2, null, Date.now(), hint2);
  check('sticky uses hint (beta) for new binding', sticky2?.alias === 'beta');

  // Third "request" (follow-up to conversation one): sticky returns existing binding
  const hint3 = pool.select(); // advances again, but sticky should override
  const sticky3 = pool.selectSticky(key1, null, Date.now(), hint3);
  check('existing binding returned for conv1', sticky3?.alias === 'alpha');

  // Verify even distribution: both accounts got bound
  check('both accounts got at least one binding', sticky1?.alias !== sticky2?.alias);
}

header('round-robin without sticky hint (affinity off) still alternates');
{
  const pool = new AccountPool('round-robin', { sessionAffinity: false });
  addAccount(pool, 'alpha', { util5h: 0.3 });
  addAccount(pool, 'beta', { util5h: 0.3 });

  const picks = [];
  for (let i = 0; i < 6; i++) picks.push(pool.select()?.alias);
  // round-robin with 2 accounts in sorted order: alpha, beta, alpha, beta...
  check('alternates alpha/beta', picks[0] === 'alpha' && picks[1] === 'beta' && picks[2] === 'alpha');
  // selectSticky with affinity off falls through to select()
  const key = computeStickyKey('some message');
  const s = pool.selectSticky(key, null, Date.now(), null);
  check('affinity off: selectSticky delegates to select()', s?.alias === 'beta' || s?.alias === 'alpha');
}

header('plan-based routing: fable restricted to Max');
{
  const pool = new AccountPool('round-robin', { sessionAffinity: true });
  addAccount(pool, 'pro-account', { util5h: 0.1 });
  addAccount(pool, 'max-account', { util5h: 0.3 });
  pool.updatePlan('pro-account', 'Pro');
  pool.updatePlan('max-account', 'Max');

  // Fable family should only route to Max
  const fable1 = pool.select('fable');
  check('fable routes to max-account only', fable1?.alias === 'max-account');
  const fable2 = pool.select('fable');
  check('fable always routes to max (never pro)', fable2?.alias === 'max-account');

  // Sonnet should route to both accounts over multiple calls (round-robin)
  const sonnetPicks = new Set();
  for (let i = 0; i < 4; i++) sonnetPicks.add(pool.select('sonnet')?.alias);
  check('sonnet routes to both accounts', sonnetPicks.has('pro-account') && sonnetPicks.has('max-account'));

  // selectSticky: fable hint pointing to Pro should be rejected
  const proHint = pool.get('pro-account');
  const fableKey = computeStickyKey('fable conversation');
  const stickyFable = pool.selectSticky(fableKey, 'fable', Date.now(), proHint);
  check('sticky rejects Pro hint for fable, picks Max', stickyFable?.alias === 'max-account');

  // selectSticky: existing binding to Pro for fable should rebind to Max
  pool.rebindSticky(computeStickyKey('bound-to-pro'), 'pro-account');
  const rebound = pool.selectSticky(computeStickyKey('bound-to-pro'), 'fable', Date.now(), proHint);
  check('sticky rebinds from Pro to Max for fable', rebound?.alias === 'max-account');
}

header('plan-based routing: unknown plan fails closed for restricted family');
{
  const pool = new AccountPool('round-robin', { sessionAffinity: false });
  addAccount(pool, 'unknown-plan', { util5h: 0.1 });
  // plan not set (null) — a Max-only request must not be guessed onto it
  const pick = pool.select('fable');
  check('unknown plan account is ineligible for fable', pick === null);
  check('unknown plan still serves unrestricted families', pool.select('sonnet')?.alias === 'unknown-plan');
}

header('selectSticky with null hint and exhausted pool returns null');
{
  const pool = new AccountPool('round-robin', { sessionAffinity: true });
  addAccount(pool, 'only-account', { util5h: 0.1, expiresInMs: 5_000 }); // expires in 5s (< 30s threshold)
  // Pool has one account but it's near-expired — select() returns null
  // (expiresAt must be > now + 30_000 to be eligible, and fallback filters
  // by !isInAuthCooldown only, but expiry check in ineligibleReason blocks it)
  pool.markAuthFailure('only-account');
  check('select() returns null when all in auth cooldown', pool.select() === null);
  // selectSticky with null hint should gracefully return null
  const key = computeStickyKey('orphan conversation');
  const result = pool.selectSticky(key, null, Date.now(), null);
  check('selectSticky returns null with null hint + exhausted pool', result === null);
  // selectSticky with a stale hint (cooldown account) should also return null
  const staleHint = pool.get('only-account');
  const result2 = pool.selectSticky(key, null, Date.now(), staleHint);
  check('selectSticky returns null with cooldown hint + exhausted pool', result2 === null);
}

header('round-robin with 3+ accounts distributes evenly');
{
  const pool = new AccountPool('round-robin', { sessionAffinity: false });
  addAccount(pool, 'alpha', { util5h: 0.2 });
  addAccount(pool, 'beta', { util5h: 0.3 });
  addAccount(pool, 'gamma', { util5h: 0.4 });

  const counts = { alpha: 0, beta: 0, gamma: 0 };
  for (let i = 0; i < 9; i++) {
    const picked = pool.select();
    counts[picked.alias]++;
  }
  // With 9 picks over 3 accounts, each should get exactly 3
  check('alpha gets 3/9 picks', counts.alpha === 3);
  check('beta gets 3/9 picks', counts.beta === 3);
  check('gamma gets 3/9 picks', counts.gamma === 3);

  // Verify order is alias-sorted: alpha, beta, gamma, alpha, ...
  const order = [];
  for (let i = 0; i < 3; i++) order.push(pool.select()?.alias);
  check('picks in alias-sorted order', order[0] === 'alpha' && order[1] === 'beta' && order[2] === 'gamma');
}

header('round-robin with 3 accounts: one exhausted drops out');
{
  const pool = new AccountPool('round-robin', { sessionAffinity: false });
  addAccount(pool, 'alpha', { util5h: 0.2 });
  addAccount(pool, 'beta', { util5h: 0.99 });  // below floor (headroom 1% < 2%)
  addAccount(pool, 'gamma', { util5h: 0.3 });

  const counts = { alpha: 0, beta: 0, gamma: 0 };
  for (let i = 0; i < 6; i++) {
    const picked = pool.select();
    counts[picked.alias]++;
  }
  // beta should be skipped (below floor), alpha and gamma split evenly
  check('exhausted beta gets 0 picks', counts.beta === 0);
  check('alpha gets 3/6 picks', counts.alpha === 3);
  check('gamma gets 3/6 picks', counts.gamma === 3);
}

header('plan hard gate: all-Pro pool + fable returns null');
{
  const pool = new AccountPool('round-robin', { sessionAffinity: false });
  addAccount(pool, 'pro1', { util5h: 0.1 });
  addAccount(pool, 'pro2', { util5h: 0.2 });
  pool.updatePlan('pro1', 'Pro');
  pool.updatePlan('pro2', 'Pro');

  // fable requires Max — with only Pro accounts, should return null
  const pick = pool.select('fable');
  check('fable returns null when all accounts are Pro', pick === null);

  // sonnet has no plan requirement — should still work
  const sonnet = pool.select('sonnet');
  check('sonnet still routes to Pro accounts', sonnet !== null);

  // selectExcluding also respects the hard gate
  const excl = pool.selectExcluding(new Set(), 'fable');
  check('selectExcluding returns null for fable with all-Pro', excl === null);
}

header('pickRoundRobin respects per-model family in floor check');
{
  const pool = new AccountPool('round-robin', { sessionAffinity: false });
  addAccount(pool, 'alpha', { util5h: 0.2, perModel7d: { sonnet: 0.99 } });  // sonnet-saturated
  addAccount(pool, 'beta', { util5h: 0.5 });

  // sonnet request: alpha is above unified floor but below per-model floor
  const sonnetPicks = new Set();
  for (let i = 0; i < 4; i++) sonnetPicks.add(pool.select('sonnet')?.alias);
  check('sonnet-saturated alpha drops out of rotation for sonnet', !sonnetPicks.has('alpha'));

  // opus request: alpha's per-model doesn't apply, both should be picked
  const opusPicks = new Set();
  for (let i = 0; i < 4; i++) opusPicks.add(pool.select('opus')?.alias);
  check('both accounts in rotation for opus', opusPicks.has('alpha') && opusPicks.has('beta'));
}

header('round-robin observation and failover preserve the cursor');
{
  const pool = new AccountPool('round-robin', { sessionAffinity: false });
  addAccount(pool, 'alpha', { util5h: 0.2 });
  addAccount(pool, 'beta', { util5h: 0.2 });
  addAccount(pool, 'gamma', { util5h: 0.2 });

  check('peek reports alpha', pool.peek()?.alias === 'alpha');
  check('status reports alpha', pool.status().bestAccount === 'alpha');
  check('read-only calls do not consume alpha', pool.select()?.alias === 'alpha');

  const failover = pool.selectExcluding(new Set(['alpha']));
  check('failover continues to beta instead of skipping to gamma', failover?.alias === 'beta');
  check('next normal turn continues to gamma', pool.select()?.alias === 'gamma');
}

header('proxy peek is replaced by one family-aware committed selection');
{
  const pool = new AccountPool('round-robin', { sessionAffinity: true });
  addAccount(pool, 'alpha', { util5h: 0.1, perModel7d: { sonnet: 0.99 } });
  addAccount(pool, 'beta', { util5h: 0.2 });

  check('family-less availability peek sees alpha', pool.peek()?.alias === 'alpha');
  const key = computeStickyKey('family-aware conversation');
  check('committed Sonnet selection skips saturated alpha', pool.selectSticky(key, 'sonnet')?.alias === 'beta');
  check('the peek consumed no hidden round-robin turn', pool.select('opus')?.alias === 'alpha');
}

header('affinity disabled reuses the proxy hint without double-selecting');
{
  const pool = new AccountPool('round-robin', { sessionAffinity: false });
  addAccount(pool, 'alpha', { util5h: 0.2 });
  addAccount(pool, 'beta', { util5h: 0.2 });

  const hint = pool.select();
  const picked = pool.selectSticky(computeStickyKey('new request'), null, Date.now(), hint);
  check('disabled affinity keeps the pre-selected alpha hint', picked?.alias === 'alpha');
  check('the next request gets beta', pool.select()?.alias === 'beta');
}

header('affinity TTL is enforced on lookup, not only periodic cleanup');
{
  const pool = new AccountPool('headroom', { sessionAffinity: true, sessionAffinityTtlMs: 10 });
  addAccount(pool, 'alpha', { util5h: 0.1 });
  addAccount(pool, 'beta', { util5h: 0.2 });
  const key = computeStickyKey('ttl-bound conversation');
  const bound = pool.get('beta');
  pool.rebindSticky(key, 'beta');
  const bindingTime = Date.now();
  check('binding is initially reused', pool.selectSticky(key, null, bindingTime, bound)?.alias === 'beta');
  check('expired binding is reselected before cleanup interval', pool.selectSticky(key, null, bindingTime + 11)?.alias === 'alpha');
}

console.log(`\n${'='.repeat(70)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(70)}`);
process.exit(fail > 0 ? 1 : 0);
