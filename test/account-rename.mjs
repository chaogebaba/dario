#!/usr/bin/env bun

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
function check(label, condition) {
  if (condition) { console.log(`  PASS ${label}`); pass++;
  } else { console.log(`  FAIL ${label}`); fail++; }
}

const home = await mkdtemp(join(tmpdir(), 'dario-account-rename-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';

const { addAccountViaOAuth, getAccountsDir, isAccountCredentials, isValidAccountAlias, listAccountAliases, loadAccount, loadAllAccounts, renameAccount, renameAccountWithResult, saveAccount, startAddAccount } =
  await import('../dist/accounts.js');

const account = (alias, token) => ({
  alias,
  accessToken: token,
  refreshToken: `refresh-${token}`,
  expiresAt: Date.now() + 60_000,
  scopes: [],
  deviceId: `device-${alias}`,
  accountUuid: `uuid-${alias}`,
});

try {
  check('64-character alias is valid', isValidAccountAlias('a'.repeat(64)));
  check('65-character alias is rejected', !isValidAccountAlias('a'.repeat(65)));
  check('alias cannot start with punctuation', !isValidAccountAlias('-hidden'));
  check('alias cannot end with a dot', !isValidAccountAlias('hidden.'));
  check('Windows reserved device name is rejected', !isValidAccountAlias('CON'));
  check('Windows reserved device stem is rejected', !isValidAccountAlias('com1.backup'));
  check('credential guard accepts a complete account', isAccountCredentials(account('guarded', 'token')));
  check('credential guard rejects missing tokens',
    !isAccountCredentials({ ...account('guarded', 'token'), accessToken: '' }));
  let invalidCredentialsRejected = false;
  try {
    await saveAccount({ ...account('invalid-creds', 'token'), scopes: [7] });
  } catch (error) {
    invalidCredentialsRejected = error?.kind === 'invalid';
  }
  check('storage rejects malformed credentials before writing', invalidCredentialsRejected);
  await saveAccount(account('alpha', 'token-alpha'));
  await saveAccount(account('beta', 'token-beta'));
  await saveAccount(account('team.json.prod', 'token-json-name'));
  check('embedded .json survives alias enumeration', (await listAccountAliases()).includes('team.json.prod'));
  check('embedded .json account survives pool loading',
    (await loadAllAccounts()).some((a) => a.alias === 'team.json.prod' && a.accessToken === 'token-json-name'));
  await saveAccount(account('Work', 'token-case'));
  let caseFoldedCreateRejected = false;
  try { await startAddAccount('work'); } catch (err) {
    caseFoldedCreateRejected = err?.code === 'EEXIST';
  }
  check('new-account flow rejects a case-folded collision before OAuth', caseFoldedCreateRejected);
  const abort = new AbortController();
  abort.abort(new Error('cancelled by test'));
  let abortedBeforeOAuth = false;
  try { await addAccountViaOAuth('cancelled-account', { signal: abort.signal }); } catch (err) {
    abortedBeforeOAuth = err?.message === 'cancelled by test';
  }
  check('already-aborted OAuth flow stops before browser work', abortedBeforeOAuth);

  const collision = await renameAccountWithResult('alpha', 'beta');
  check('rename reports an existing destination as a conflict', collision === 'conflict');
  check('source survives a conflicting rename', (await loadAccount('alpha'))?.accessToken === 'token-alpha');
  check('destination credential is not overwritten', (await loadAccount('beta'))?.accessToken === 'token-beta');
  check('case-only rename is rejected portably', await renameAccountWithResult('beta', 'BETA') === 'conflict');

  const renamed = await renameAccount('alpha', 'gamma');
  check('boolean compatibility API reports a successful rename', renamed === true);
  check('old alias is removed after success', await loadAccount('alpha') === null);
  const gamma = await loadAccount('gamma');
  check('new alias carries the source credential', gamma?.accessToken === 'token-alpha');
  check('persisted alias matches its filename', gamma?.alias === 'gamma');
  check('missing source is distinguished', await renameAccountWithResult('missing', 'new') === 'not-found');
  check('invalid alias is distinguished', await renameAccountWithResult('../gamma', 'new') === 'invalid');

  await mkdir(getAccountsDir(), { recursive: true });
  await writeFile(join(getAccountsDir(), 'corrupt.json'), '{not json', 'utf-8');
  check('corrupt credential is an internal failure',
    await renameAccountWithResult('corrupt', 'recovered') === 'internal');
} finally {
  await rm(home, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
