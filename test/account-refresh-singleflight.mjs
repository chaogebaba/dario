// Unit test for the per-alias single-flight guard on refreshAccountToken
// (v3.17). Two concurrent calls for the same alias must share one fetch;
// two concurrent calls for *different* aliases must each run their own.
//
// Strategy: monkey-patch globalThis.fetch with a counter + controllable
// promise, then race calls. No real network. The `detectCCOAuthConfig`
// call inside doRefreshAccountToken hits the filesystem to scan CC
// config — we let it run (returns a fallback if nothing is found) and
// just care about counting the outbound refresh_token POSTs.

import {
  refreshAccountToken,
  _accountRefreshesInFlightSizeForTest as inFlightSize,
  saveAccount,
  removeAccount,
  loadAccount,
  renameAccountWithResult,
} from '../dist/accounts.js';
import { detectCCOAuthConfig } from '../dist/cc-oauth-detect.js';

// Warm the OAuth detector before anything is on a clock. doRefreshAccountToken
// awaits detectCCOAuthConfig, which on a cold cache reads and scans the whole
// installed Claude Code binary — 319 MB of it here. The runner hands every
// suite a HOME of its own, so ~/.dario's cache is cold on every run and that
// scan lands inside waitForFetches' budget: ~1.4s idle, 4-5s at
// TEST_CONCURRENCY=12, over 20s in a burst. That is what made this file fail
// once in a concurrent run and pass on its own. Nothing here asserts anything
// about the scan, so memoize it first and let the budget cover the refresh.
await detectCCOAuthConfig();

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}
function header(label) {
  console.log(`\n======================================================================`);
  console.log(`  ${label}`);
  console.log(`======================================================================`);
}

// ----- fetch stub ------------------------------------------------------
const originalFetch = globalThis.fetch;
let fetchCallCount = 0;
let fetchResolvers = [];
let fetchHitListeners = [];
function installStub() {
  fetchCallCount = 0;
  fetchResolvers = [];
  fetchHitListeners = [];
  globalThis.fetch = (_url, _init) => {
    fetchCallCount++;
    for (const l of fetchHitListeners) l(fetchCallCount);
    return new Promise((resolve) => {
      fetchResolvers.push(resolve);
    });
  };
}
// Wait until `expected` fetches have hit the stub. Event-driven (no sleep)
// so the test isn't racing real clock time — it resolves the moment the
// async filesystem scan in `detectCCOAuthConfig` completes and fires the
// refresh POST.
function waitForFetches(expected, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (fetchCallCount >= expected) return resolve();
    const listener = (n) => {
      if (n >= expected) {
        fetchHitListeners = fetchHitListeners.filter((l) => l !== listener);
        resolve();
      }
    };
    fetchHitListeners.push(listener);
    setTimeout(() => {
      fetchHitListeners = fetchHitListeners.filter((l) => l !== listener);
      reject(new Error(`timed out waiting for ${expected} fetch(es); saw ${fetchCallCount}`));
    }, timeoutMs);
  });
}
function resolveAllPendingWithRefresh(alias) {
  for (const resolve of fetchResolvers) {
    resolve(new Response(JSON.stringify({
      access_token: `new-${alias}-${Math.random().toString(36).slice(2, 7)}`,
      refresh_token: `new-refresh-${alias}`,
      expires_in: 28800,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
  }
  fetchResolvers = [];
}
function restoreFetch() {
  globalThis.fetch = originalFetch;
}

// ----- fixture creds ---------------------------------------------------
const fixtureA = {
  alias: 'test-singleflight-a',
  accessToken: 'old-a',
  refreshToken: 'refresh-a',
  expiresAt: Date.now() + 1000,
  scopes: [],
  deviceId: 'd-a',
  accountUuid: 'u-a',
};
const fixtureB = { ...fixtureA, alias: 'test-singleflight-b', refreshToken: 'refresh-b' };

// ======================================================================
//  Same alias, concurrent calls → one fetch, shared in-flight
// ======================================================================
header('refreshAccountToken — two concurrent calls for same alias share one fetch');
{
  installStub();
  await saveAccount(fixtureA);
  const p1 = refreshAccountToken(fixtureA);
  const p2 = refreshAccountToken(fixtureA);
  // Silence unhandled rejections — the test later rejects both via the
  // stubbed fetch resolver. Catch here so Node doesn't warn on the
  // in-flight references before we await.
  p1.catch(() => {});
  p2.catch(() => {});
  check('in-flight map has one entry', inFlightSize() === 1);

  await waitForFetches(1);
  check('fetch called exactly once across both concurrent calls', fetchCallCount === 1);

  resolveAllPendingWithRefresh('a');
  const [r1, r2] = await Promise.all([p1, p2]);
  check('both callers resolve to the same access token', r1.accessToken === r2.accessToken);
  check('in-flight map cleared after completion', inFlightSize() === 0);
  await removeAccount(fixtureA.alias);
}

// ======================================================================
//  Different aliases, concurrent calls → two fetches
// ======================================================================
header('refreshAccountToken — different aliases do not share in-flight slot');
{
  installStub();
  await Promise.all([saveAccount(fixtureA), saveAccount(fixtureB)]);
  const pA = refreshAccountToken(fixtureA);
  const pB = refreshAccountToken(fixtureB);
  pA.catch(() => {});
  pB.catch(() => {});
  check('in-flight map has two entries', inFlightSize() === 2);

  await waitForFetches(2);
  check('fetch called once per alias (2 calls total)', fetchCallCount === 2);

  resolveAllPendingWithRefresh('ab');
  const [rA, rB] = await Promise.all([pA, pB]);
  check('alias A token differs from B', rA.accessToken !== rB.accessToken);
  check('in-flight map cleared after both complete', inFlightSize() === 0);
  await removeAccount(fixtureA.alias);
  await removeAccount(fixtureB.alias);
}

// ======================================================================
//  Sequential calls (one completes before next starts) → two fetches
// ======================================================================
header('refreshAccountToken — sequential calls each get their own fetch');
{
  installStub();
  await saveAccount(fixtureA);
  const p1 = refreshAccountToken(fixtureA);
  p1.catch(() => {});
  await waitForFetches(1);
  resolveAllPendingWithRefresh('a');
  await p1;
  check('in-flight map empty between sequential calls', inFlightSize() === 0);

  const p2 = refreshAccountToken(fixtureA);
  p2.catch(() => {});
  await waitForFetches(2);
  check('second sequential call issued a fresh fetch (total 2)', fetchCallCount === 2);
  resolveAllPendingWithRefresh('a');
  await p2;
  await removeAccount(fixtureA.alias);
}

// ======================================================================
//  Rename/remove serialize behind an in-flight token rotation
// ======================================================================
header('account mutations wait for an in-flight refresh');
{
  const renamedAlias = 'test-singleflight-renamed';
  installStub();
  await saveAccount(fixtureA);
  const refreshing = refreshAccountToken(fixtureA);
  await waitForFetches(1);
  const renaming = renameAccountWithResult(fixtureA.alias, renamedAlias);
  await Promise.resolve();
  check('rename does not publish while refresh owns the alias', await loadAccount(renamedAlias) === null);
  resolveAllPendingWithRefresh('race');
  await refreshing;
  check('rename succeeds after refresh completes', await renaming === 'renamed');
  check('old alias is not recreated', await loadAccount(fixtureA.alias) === null);
  check('new alias keeps the rotated refresh token',
    (await loadAccount(renamedAlias))?.refreshToken === 'new-refresh-race');

  installStub();
  const renamed = await loadAccount(renamedAlias);
  const refreshingBeforeDelete = refreshAccountToken(renamed);
  await waitForFetches(1);
  const removing = removeAccount(renamedAlias);
  resolveAllPendingWithRefresh('delete-race');
  await refreshingBeforeDelete;
  check('delete succeeds after refresh completes', await removing === true);
  check('deleted alias stays deleted', await loadAccount(renamedAlias) === null);
}

// ======================================================================
//  Public saves share the same alias lock as refresh/mutation operations
// ======================================================================
header('saveAccount waits for an in-flight refresh');
{
  installStub();
  await saveAccount(fixtureA);
  const refreshing = refreshAccountToken(fixtureA);
  await waitForFetches(1);
  const replacement = { ...fixtureA, accessToken: 'manual-replacement', expiresAt: Date.now() + 120_000 };
  const saving = saveAccount(replacement);
  await Promise.resolve();
  check('queued save cannot overwrite while refresh owns the alias',
    (await loadAccount(fixtureA.alias))?.accessToken === fixtureA.accessToken);

  resolveAllPendingWithRefresh('save-race');
  await refreshing;
  await saving;
  check('queued save runs after refresh releases the alias',
    (await loadAccount(fixtureA.alias))?.accessToken === 'manual-replacement');
  await removeAccount(fixtureA.alias);
}

// ----- cleanup ---------------------------------------------------------
restoreFetch();

console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);
