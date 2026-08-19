#!/usr/bin/env bun
// A refresh error must not outlive the credentials it was raised against.
//
// `pool.add` is the path that installs credentials, and reconcile re-adds every
// account from disk on every run. Carrying `refreshError` forward across a
// token change therefore pinned the message permanently: an account refreshed
// by another dario instance, or re-authed out of band, kept reporting
// refresh-failed while holding a working token, because nothing on the
// reconcile path calls setRefreshError('').
//
// The status field had the matching ordering bug. `refresh-failed` outranked
// `auth-cooldown`, so a stale message masked the live cooldown that is the
// account's actual reason for being ineligible — and unlike refresh-failed,
// auth-cooldown is a reason `ineligibleReason` agrees with.

import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
function check(label, condition) {
  if (condition) { console.log(`  PASS ${label}`); pass++; }
  else { console.log(`  FAIL ${label}`); fail++; }
}

const home = await mkdtemp(join(tmpdir(), 'dario-refresh-error-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';

const { AccountPool, ineligibleReason } = await import('../dist/pool.js');
const { handleAccountRoute } = await import('../dist/account-routes.js');

const creds = (token) => ({
  accessToken: token,
  refreshToken: `refresh-${token}`,
  expiresAt: Date.now() + 3_600_000,
  deviceId: 'device-a',
  accountUuid: 'uuid-a',
});

const pool = new AccountPool();
pool.add('acct', creds('token-1'));
pool.setRefreshError('acct', 'boom: refresh rejected');
check('setRefreshError records the message', pool.get('acct')?.refreshError === 'boom: refresh rejected');

// Reconcile with the SAME credentials: nothing disproves the error, so it stays.
pool.add('acct', creds('token-1'));
check(
  'a reconcile that changes nothing keeps the error',
  pool.get('acct')?.refreshError === 'boom: refresh rejected',
);

// Reconcile with a NEW token: something refreshed successfully, so the error is
// stale by construction. This is the case that used to stick forever.
pool.add('acct', creds('token-2'));
check('a rotated token clears the stale error', pool.get('acct')?.refreshError === undefined);
check('the rotated token is the one installed', pool.get('acct')?.accessToken === 'token-2');

// A disable toggle re-adds with unchanged credentials and must not lose it.
pool.setRefreshError('acct', 'boom again');
pool.add('acct', { ...creds('token-2'), enabled: false });
check('a toggle-driven re-add keeps the error', pool.get('acct')?.refreshError === 'boom again');

// A real refresh clears it through the normal path.
pool.updateTokens('acct', 'token-3', 'refresh-token-3', Date.now() + 3_600_000);
check('updateTokens clears the error', pool.get('acct')?.refreshError === undefined);

// --- status ordering, over the real route ---
const acct = pool.get('acct');
acct.enabled = true;
acct.refreshError = 'stale message';
acct.lastAuthFailureAt = Date.now();
acct.consecutiveAuthFailures = 3;
check('the account is genuinely in auth cooldown', ineligibleReason(acct) === 'auth-cooldown');

const deps = {
  pool,
  quotaCache: new Map(),
  quotaCacheMs: 60_000,
  renameBodyTimeoutMs: 50,
  jsonHeaders: { 'Content-Type': 'application/json' },
  isLoopbackAddress: () => true,
  reconcile: async () => {},
  retryModelCatalog: () => {},
  probePlans: () => {},
  fetchQuota: async () => ({ windows: [], plan: null, email: null, extraUsage: null, fetchedAt: Date.now() }),
};

const server = createServer(async (req, res) => {
  if (!await handleAccountRoute(req, res, req.url?.split('?')[0] ?? '', deps)) {
    res.writeHead(404);
    res.end();
  }
});

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const body = await (await fetch(`http://127.0.0.1:${server.address().port}/accounts`)).json();
  const summary = body.accounts?.find((a) => a.alias === 'acct');
  check('status reports the cooldown, not the stale refresh error', summary?.status === 'auth-cooldown');
  check('the refresh error is still surfaced in its own field', summary?.refreshError === 'stale message');
  check('the cooldown carries its remaining duration', typeof summary?.cooldownMs === 'number' && summary.cooldownMs > 0);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log(`\naccount-refresh-error-cleared: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
