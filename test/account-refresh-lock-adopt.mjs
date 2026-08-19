#!/usr/bin/env bun
// The distributed lock's adopt path must not overwrite local state.
//
// When another instance has already refreshed an alias, the lock service hands
// back that instance's credential record and we skip the Anthropic call. The
// record was taken whole and written straight to disk — but `enabled`,
// `deviceId`, `accountUuid` and `scopes` are local state, not token state. A
// peer that had the account enabled resurrected a locally disabled one, and the
// peer's device identity replaced this install's.
//
// The alias mattered more: it names the file about to be written. A response
// naming a different alias clobbered an unrelated account, and the runtime
// guard on the storage boundary was called without its expectedAlias argument
// so it could not catch that.
//
// `doRefreshAccountToken` has always spread over the local record and taken
// only the token triple. This is that, on the adopt path.

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  PASS ${label}`); pass++; }
  else { console.log(`  FAIL ${label}`); fail++; }
}

const home = await mkdtemp(join(tmpdir(), 'dario-adopt-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';
process.env.DARIO_REFRESH_LOCK_URL = 'https://lock.invalid';

const { loadAccount, refreshAccountToken, saveAccount } = await import('../dist/accounts.js');

const local = {
  alias: 'mine',
  accessToken: 'local-access',
  refreshToken: 'local-refresh',
  expiresAt: 1000,
  scopes: ['user:inference'],
  deviceId: 'device-LOCAL',
  accountUuid: 'uuid-LOCAL',
  enabled: false,
};
const bystander = { ...local, alias: 'bystander', deviceId: 'device-BYSTANDER', enabled: true };

const originalFetch = globalThis.fetch;
// `remote` is what the lock service claims another instance refreshed to.
// `oauth` counts real Anthropic refreshes so the fail-open path is provable.
let remote = null;
let oauthCalls = 0;
globalThis.fetch = async (url) => {
  const href = String(url);
  if (href.includes('/lock/')) {
    return Response.json(href.includes('/acquire') ? { acquired: false, credentials: remote } : {});
  }
  oauthCalls++;
  return Response.json({ access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 3600 });
};

try {
  await saveAccount(local);
  await saveAccount(bystander);

  // --- adopt: same alias, peer's record differs on every local-only field ---
  remote = {
    alias: 'mine',
    accessToken: 'peer-access',
    refreshToken: 'peer-refresh',
    expiresAt: 9_999_000,
    scopes: [],
    deviceId: 'device-PEER',
    accountUuid: 'uuid-PEER',
    enabled: true,
  };
  const adopted = await refreshAccountToken(local);

  check('adopting skips the Anthropic refresh entirely', oauthCalls === 0);
  check('adopts the peer access token', adopted.accessToken === 'peer-access');
  check('adopts the peer refresh token', adopted.refreshToken === 'peer-refresh');
  check('adopts the peer expiry', adopted.expiresAt === 9_999_000);
  check('does NOT resurrect a locally disabled account', adopted.enabled === false);
  check('keeps this install\'s device id', adopted.deviceId === 'device-LOCAL');
  check('keeps the local account uuid', adopted.accountUuid === 'uuid-LOCAL');
  check('keeps the local scopes', JSON.stringify(adopted.scopes) === JSON.stringify(['user:inference']));

  const onDisk = await loadAccount('mine');
  check('the adopted record is what got persisted', onDisk?.accessToken === 'peer-access');
  check('the persisted record stays disabled', onDisk?.enabled === false);
  check('the persisted record keeps the local device id', onDisk?.deviceId === 'device-LOCAL');

  // --- refuse: the lock service names someone else's account ---
  remote = { ...remote, alias: 'bystander', accessToken: 'hijack-access' };
  const refused = await refreshAccountToken(local);

  check('a mismatched alias falls open to a real refresh', oauthCalls === 1);
  check('the real refresh result is returned', refused.accessToken === 'fresh-access');
  check('the refused response never reached disk', (await loadAccount('mine'))?.accessToken === 'fresh-access');
  check('the bystander account is untouched', (await loadAccount('bystander'))?.accessToken === 'local-access');
  check('the bystander keeps its own device id', (await loadAccount('bystander'))?.deviceId === 'device-BYSTANDER');

  // --- refuse: a structurally invalid record ---
  remote = { alias: 'mine', accessToken: '', refreshToken: 'x', expiresAt: 1, scopes: [], deviceId: '', accountUuid: '' };
  const refusedInvalid = await refreshAccountToken(local);
  check('a malformed lock response falls open too', oauthCalls === 2);
  check('the malformed response never reached disk', refusedInvalid.accessToken === 'fresh-access');
} finally {
  globalThis.fetch = originalFetch;
}

console.log(`\naccount-refresh-lock-adopt: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
