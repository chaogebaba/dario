// The distributed refresh lock cast its acquire reply with
// `(await res.json()) as T` — an assertion nothing checked. Same monkeypatched
// fetch as account-refresh-distributed-lock.mjs: no real network.
//
// Two distinct failures came out of that cast:
//
//   `acquired` is read for truthiness, so a body carrying the STRING "false"
//   claimed a lease this instance never held — it refreshed and then released
//   a lock belonging to someone else, which is the exact race the lock exists
//   to prevent.
//
//   `retryAfterMs` reaches `Math.min(x, 3_000)`, so a string or a NaN makes
//   `sleep()` resolve on the next tick and burns all 8 attempts in one go —
//   a backoff loop that does not back off.
//
// Both are now lock-service faults, and a lock-service fault fails OPEN: the
// refresh happens directly, exactly as if DARIO_REFRESH_LOCK_URL were unset.

import { refreshAccountToken, removeAccount, saveAccount } from '../dist/accounts.js';

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

const originalFetch = globalThis.fetch;
const fixture = {
  alias: 'test-lock-reply-account',
  accessToken: 'old-access',
  refreshToken: 'old-refresh',
  expiresAt: 1000,
  scopes: [],
  deviceId: 'd-1',
  accountUuid: 'u-1',
};

// Drives one refresh with a stubbed acquire reply and reports what the lock
// layer did with it. `reply` is either a Response factory or a literal body.
async function runWithAcquireReply(reply) {
  process.env.DARIO_REFRESH_LOCK_URL = 'http://lock.test';
  process.env.DARIO_REFRESH_LOCK_TOKEN = 'tok';
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/acquire')) return typeof reply === 'function' ? reply() : new Response(JSON.stringify(reply), { status: 200 });
    if (u.includes('/release')) return new Response(JSON.stringify({ released: true }), { status: 200 });
    return new Response(JSON.stringify({ access_token: 'new-a', refresh_token: 'new-r', expires_in: 100 }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await saveAccount(fixture);
  const started = Date.now();
  const updated = await refreshAccountToken(fixture);
  const elapsed = Date.now() - started;
  await removeAccount(fixture.alias);
  globalThis.fetch = originalFetch;
  delete process.env.DARIO_REFRESH_LOCK_URL;
  delete process.env.DARIO_REFRESH_LOCK_TOKEN;
  return {
    updated,
    elapsed,
    acquires: calls.filter((u) => u.includes('/acquire')).length,
    releases: calls.filter((u) => u.includes('/release')).length,
    refreshes: calls.filter((u) => u.includes('/oauth/token')).length,
  };
}

// ======================================================================
header('a 200 whose body is not an acquire reply fails open on the first try');
for (const [label, body] of [
  ['a bare null', null],
  ['an array', []],
  ['a string', 'acquired'],
  ['a number', 7],
  ['an object with no `acquired` field', { retryAfterMs: 100 }],
  ['`acquired` as the string "true"', { acquired: 'true' }],
  ['`acquired` as the string "false"', { acquired: 'false' }],
  ['`acquired` as 1', { acquired: 1 }],
]) {
  const r = await runWithAcquireReply(body);
  check(`${label}: refreshes directly anyway`, r.updated.accessToken === 'new-a' && r.refreshes === 1);
  check(`${label}: asks once and gives up, no 8-attempt loop`, r.acquires === 1);
  check(`${label}: never releases a lease it does not hold`, r.releases === 0);
}

// ======================================================================
header('a malformed retryAfterMs is a fault, not a zero backoff');
for (const [label, body] of [
  ['a string', { acquired: false, retryAfterMs: 'soon' }],
  ['NaN over the wire (null)', { acquired: false, retryAfterMs: null }],
  ['a negative number', { acquired: false, retryAfterMs: -1 }],
]) {
  const r = await runWithAcquireReply(body);
  check(`retryAfterMs as ${label}: one acquire, then fail open`, r.acquires === 1 && r.refreshes === 1);
}

// ======================================================================
header('a non-JSON 200 was already handled — pin it');
{
  const r = await runWithAcquireReply(() => new Response('<html>502 Bad Gateway</html>', {
    status: 200, headers: { 'content-type': 'text/html' },
  }));
  check('an HTML error page behind a 200 fails open', r.refreshes === 1 && r.acquires === 1);
  check('and releases nothing', r.releases === 0);
}

// ======================================================================
header('well-formed replies are untouched by the guard');
{
  const r = await runWithAcquireReply({ acquired: true });
  check('acquired:true still refreshes', r.refreshes === 1 && r.updated.accessToken === 'new-a');
  check('acquired:true still releases the lease', r.releases === 1);
}
{
  // A real backoff: refused twice with a hint, then granted. The loop must
  // survive the guard, and the hint must still be honoured as a delay.
  process.env.DARIO_REFRESH_LOCK_URL = 'http://lock.test';
  process.env.DARIO_REFRESH_LOCK_TOKEN = 'tok';
  let attempt = 0;
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/acquire')) {
      attempt++;
      if (attempt <= 2) return new Response(JSON.stringify({ acquired: false, retryAfterMs: 20 }), { status: 200 });
      return new Response(JSON.stringify({ acquired: true }), { status: 200 });
    }
    if (u.includes('/release')) return new Response(JSON.stringify({ released: true }), { status: 200 });
    return new Response(JSON.stringify({ access_token: 'new-a', refresh_token: 'new-r', expires_in: 100 }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await saveAccount(fixture);
  const started = Date.now();
  const updated = await refreshAccountToken(fixture);
  const elapsed = Date.now() - started;
  await removeAccount(fixture.alias);
  globalThis.fetch = originalFetch;
  delete process.env.DARIO_REFRESH_LOCK_URL;
  delete process.env.DARIO_REFRESH_LOCK_TOKEN;

  check('retries until granted', calls.filter((u) => u.includes('/acquire')).length === 3);
  check('then refreshes and releases', updated.accessToken === 'new-a'
    && calls.filter((u) => u.includes('/release')).length === 1);
  check('and actually waited out both hints', elapsed >= 35);
}

// ======================================================================
header('a cached-credentials reply still adopts, and a bad one still fails open');
{
  process.env.DARIO_REFRESH_LOCK_URL = 'http://lock.test';
  process.env.DARIO_REFRESH_LOCK_TOKEN = 'tok';
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/acquire')) {
      return new Response(JSON.stringify({
        acquired: false,
        credentials: {
          alias: fixture.alias,
          accessToken: 'adopted-a', refreshToken: 'adopted-r',
          expiresAt: Date.now() + 3600_000,
          scopes: [], deviceId: 'd-1', accountUuid: 'u-1',
        },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ access_token: 'new-a', refresh_token: 'new-r', expires_in: 100 }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await saveAccount(fixture);
  const updated = await refreshAccountToken(fixture);
  await removeAccount(fixture.alias);
  globalThis.fetch = originalFetch;
  delete process.env.DARIO_REFRESH_LOCK_URL;
  delete process.env.DARIO_REFRESH_LOCK_TOKEN;

  check('adopts the cached token without an Anthropic call',
    updated.accessToken === 'adopted-a' && calls.filter((u) => u.includes('/oauth/token')).length === 0);
}

console.log(`\n${'='.repeat(70)}\n  ${pass} pass, ${fail} fail\n${'='.repeat(70)}`);
process.exit(fail === 0 ? 0 : 1);
