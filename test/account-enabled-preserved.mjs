#!/usr/bin/env bun
// A re-login must not resurrect a disabled account.
//
// `completeAddAccount(..., { replaceExisting: true })` rebuilds the credential
// record from the OAuth token exchange, which knows nothing about operator
// state. The rebuilt record carries no `enabled` field, and loadAccount's
// `enabled !== false` default reads a missing field as enabled — so without
// the carry-forward in replaceAccount, re-logging in a benched account puts it
// straight back into routing with no sign anything happened. The merge lives
// inside the alias lock so a concurrent toggle can't be clobbered.

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
function check(label, condition) {
  if (condition) { console.log(`  PASS ${label}`); pass++; }
  else { console.log(`  FAIL ${label}`); fail++; }
}

const home = await mkdtemp(join(tmpdir(), 'dario-account-enabled-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';

const { loadAccount, replaceAccount, saveAccount, toggleAccountEnabled } =
  await import('../dist/account-store.js');

const account = (alias, token) => ({
  alias,
  accessToken: token,
  refreshToken: `refresh-${token}`,
  expiresAt: Date.now() + 60_000,
  scopes: ['user:inference'],
  deviceId: `device-${alias}`,
  accountUuid: `uuid-${alias}`,
});

// A record written without `enabled` reads back as enabled — the default the
// carry-forward has to defend against.
await saveAccount(account('benched', 'token-1'));
check('missing enabled reads as enabled', (await loadAccount('benched'))?.enabled === true);

const toggled = await toggleAccountEnabled('benched');
check('toggle disables the account', toggled?.enabled === false);
check('disabled state is persisted', (await loadAccount('benched'))?.enabled === false);

// The shape completeAddAccount hands to replaceAccount: fresh tokens, no
// `enabled` key at all.
await replaceAccount(account('benched', 'token-2'));
const afterRelogin = await loadAccount('benched');
check('re-login rotates the token', afterRelogin?.accessToken === 'token-2');
check('re-login does NOT re-enable a disabled account', afterRelogin?.enabled === false);

// The same carry-forward must not flip an enabled account off.
await saveAccount(account('live', 'token-1'));
await replaceAccount(account('live', 'token-2'));
const liveAfter = await loadAccount('live');
check('re-login leaves an enabled account enabled', liveAfter?.enabled === true);
check('re-login rotates the enabled account token', liveAfter?.accessToken === 'token-2');

// An explicit `enabled` in the incoming record is a deliberate state change
// and still wins — the merge only fills an absent field.
await replaceAccount({ ...account('benched', 'token-3'), enabled: true });
check('explicit enabled:true overrides the carry-forward', (await loadAccount('benched'))?.enabled === true);
await replaceAccount({ ...account('live', 'token-3'), enabled: false });
check('explicit enabled:false overrides the carry-forward', (await loadAccount('live'))?.enabled === false);

console.log(`\naccount-enabled-preserved: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
