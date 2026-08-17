#!/usr/bin/env bun

import { AccountPool, EMPTY_SNAPSHOT } from '../dist/pool.js';
import { RoutingTraceStore, describeAffinity } from '../dist/routing-trace.js';
import { formatRoutingReport } from '../dist/cli.js';

let pass = 0, fail = 0;
function check(label, condition) {
  if (condition) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`); }
}

function add(pool, alias, { plan = 'Max', util5h = 0.1 } = {}) {
  pool.add(alias, {
    accessToken: `token-${alias}`,
    refreshToken: `refresh-${alias}`,
    expiresAt: Date.now() + 3_600_000,
    deviceId: `device-${alias}`,
    accountUuid: `uuid-${alias}`,
  });
  pool.updatePlan(alias, plan);
  pool.updateRateLimits(alias, {
    ...EMPTY_SNAPSHOT,
    util5h,
    measured: true,
    status: 'allowed',
    updatedAt: Date.now(),
  });
}

function selectAndTrace(pool, store, req, key, family = 'sonnet') {
  const before = pool.routingDiagnostic(family);
  const bindingBefore = pool.stickyAliasFor(key, family);
  const selection = pool.selectStickyWithLease(key, family);
  const after = pool.routingDiagnostic(family);
  const handle = store.start({
    req,
    method: 'POST',
    path: '/v1/messages',
    model: 'claude-sonnet-4-6',
    family,
    stickyKey: key,
    bindingBefore,
    before,
    after,
    selected: selection.account?.alias ?? null,
  });
  handle.finish(200, 12);
  return selection.account?.alias ?? null;
}

console.log('\nrouting trace: round-robin and affinity diagnosis');
{
  const pool = new AccountPool('round-robin', { sessionAffinity: true, sessionAffinityTtlMs: 60_000 });
  add(pool, 'alpha');
  add(pool, 'beta');
  const store = new RoutingTraceStore(8);
  const rawKey = 'claude:secret-conversation-id';

  check('first affinity key selects alpha', selectAndTrace(pool, store, 1, rawKey) === 'alpha');
  check('same affinity key remains on alpha', selectAndTrace(pool, store, 2, rawKey) === 'alpha');
  check('next affinity key advances round-robin to beta', selectAndTrace(pool, store, 3, 'claude:other-secret') === 'beta');

  const report = store.report(pool.routingDiagnostic('sonnet'), 8);
  check('repeat is classified as affinity hit', report.events[1].selectionReason === 'affinity-hit');
  check('new keys expose cursor movement', report.events[0].cursor.before === 'alpha' && report.events[0].cursor.after === 'beta');
  check('selected account counts are aggregated', report.counts.selected.alpha === 2 && report.counts.selected.beta === 1);
  check('dominant repeated key is diagnosed', report.diagnosis.dominantCause === 'balanced');
  const serialized = JSON.stringify(report);
  check('raw affinity ID is never serialized', !serialized.includes('secret-conversation-id'));
  check('request content and credential fields are absent', !serialized.includes('accessToken') && !serialized.includes('refreshToken'));
  check('fingerprint is stable and short', describeAffinity(rawKey).fingerprint?.length === 12);
  check('human formatter includes diagnosis and decisions', formatRoutingReport(report).includes('Recent decisions:'));
}

console.log('\nrouting trace: single-affinity diagnosis and bounds');
{
  const pool = new AccountPool('round-robin');
  add(pool, 'alpha');
  add(pool, 'beta');
  const store = new RoutingTraceStore(3);
  for (let i = 1; i <= 5; i++) selectAndTrace(pool, store, i, 'session:one-stable-key');
  const report = store.report(pool.routingDiagnostic('sonnet'), 99);
  check('ring buffer retains only its capacity', report.retained === 3 && report.events.length === 3);
  check('newest event is first', report.events[0].req === 5 && report.events[2].req === 3);
  check('single reused key is diagnosed', report.diagnosis.dominantCause === 'single-affinity-key');
  check('diagnosis explains new-key round-robin semantics', report.diagnosis.summary.includes('new affinity key'));
}

console.log('\nrouting trace: failover and selector reasons');
{
  const pool = new AccountPool('round-robin');
  add(pool, 'alpha');
  add(pool, 'beta');
  pool.markAuthFailure('alpha');
  const snapshot = pool.routingDiagnostic('sonnet');
  check('diagnostic uses selector auth-cooldown reason', snapshot.candidates[0].reason === 'auth-cooldown');
  check('healthy peer remains eligible', snapshot.candidates[1].eligible === true);

  const store = new RoutingTraceStore();
  const handle = store.start({
    req: 1,
    method: 'POST',
    path: '/v1/messages',
    model: 'claude-sonnet-4-6',
    family: 'sonnet',
    stickyKey: null,
    bindingBefore: null,
    before: snapshot,
    after: snapshot,
    selected: 'alpha',
  });
  handle.failover('beta', 401, 'auth');
  handle.release('upstream-5xx');
  handle.finish(503, 44.7);
  const event = store.report(snapshot).events[0];
  check('failover preserves from/to/status/reason', event.failovers[0].from === 'alpha' && event.failovers[0].to === 'beta' && event.failovers[0].status === 401);
  check('final selected account follows failover', event.selected === 'beta');
  check('release and final outcome are visible', event.released === 'upstream-5xx' && event.status === 503 && event.latencyMs === 45);
}

console.log('\nrouting trace: stale completion guards');
{
  const pool = new AccountPool('round-robin');
  add(pool, 'alpha');
  const account = pool.get('alpha');
  const rejectionEpoch = account.rejectionEpoch;
  pool.markRejected('alpha', {
    ...EMPTY_SNAPSHOT,
    util5h: 0.9,
    status: 'rejected',
    measured: true,
    updatedAt: Date.now(),
  }, null, 60_000);
  pool.updateRateLimits('alpha', {
    ...EMPTY_SNAPSHOT,
    util5h: 0.1,
    status: 'allowed',
    measured: true,
    updatedAt: Date.now(),
  }, null, true, rejectionEpoch);
  check('stale measured success cannot overwrite rejection snapshot', pool.get('alpha').rateLimit.status === 'rejected' && pool.get('alpha').rateLimit.util5h === 0.9);

  const authEpoch = pool.get('alpha').authFailureEpoch;
  pool.markAuthFailure('alpha');
  pool.clearAuthFailure('alpha', authEpoch);
  check('stale success cannot clear newer auth cooldown', pool.get('alpha').consecutiveAuthFailures === 1);
  pool.clearAuthFailure('alpha', pool.get('alpha').authFailureEpoch);
  check('current success can clear auth cooldown', pool.get('alpha').consecutiveAuthFailures === 0);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
