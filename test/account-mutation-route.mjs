#!/usr/bin/env bun

import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
function check(label, condition) {
  if (condition) { console.log(`  PASS ${label}`); pass++;
  } else { console.log(`  FAIL ${label}`); fail++; }
}

const home = await mkdtemp(join(tmpdir(), 'dario-account-routes-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';

const { handleAccountRoute, parseAccountMutationPath } = await import('../dist/account-routes.js');
const { getAccountsDir, saveAccount } = await import('../dist/accounts.js');
const { AccountPool, reconcilePoolAccounts } = await import('../dist/pool.js');

check('delete accepts exactly one encoded alias segment',
  JSON.stringify(parseAccountMutationPath('/accounts/name%20one')) === JSON.stringify({ action: 'delete', alias: 'name one' }));
check('rename accepts the exact action suffix',
  JSON.stringify(parseAccountMutationPath('/accounts/alpha/rename')) === JSON.stringify({ action: 'rename', alias: 'alpha' }));
check('malformed delete encoding is captured instead of thrown',
  parseAccountMutationPath('/accounts/%')?.alias === null);
check('malformed rename encoding is captured instead of thrown',
  parseAccountMutationPath('/accounts/%E0%A4%A/rename')?.alias === null);
check('extra delete path segments do not match',
  parseAccountMutationPath('/accounts/alpha/anything') === null);
check('extra rename path segments do not match',
  parseAccountMutationPath('/accounts/alpha/rename/anything') === null);
check('collection path is not a mutation', parseAccountMutationPath('/accounts') === null);

const account = (alias, token) => ({
  alias,
  accessToken: token,
  refreshToken: `refresh-${token}`,
  expiresAt: Date.now() + 60_000,
  scopes: [],
  deviceId: `device-${alias}`,
  accountUuid: `uuid-${alias}`,
});

const pool = new AccountPool();
const quotaCache = new Map();
let reconciles = 0;
let probes = 0;
let quotaFetches = 0;
const deps = {
  pool,
  quotaCache,
  quotaCacheMs: 60_000,
  renameBodyTimeoutMs: 50,
  jsonHeaders: { 'Content-Type': 'application/json' },
  isLoopbackAddress: () => true,
  reconcile: async () => {
    reconciles++;
    const { loadAllAccounts } = await import('../dist/accounts.js');
    return reconcilePoolAccounts(pool, await loadAllAccounts());
  },
  retryModelCatalog: () => {},
  probePlans: () => { probes++; },
  fetchQuota: async () => {
    quotaFetches++;
    return {
      windows: [], plan: 'Max', email: null, extraUsage: null, fetchedAt: Date.now(),
    };
  },
};

const server = createServer(async (req, res) => {
  if (!await handleAccountRoute(req, res, req.url?.split('?')[0] ?? '', deps)) {
    res.writeHead(404);
    res.end();
  }
});

try {
  await saveAccount(account('alpha', 'token-alpha'));
  await deps.reconcile();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const accountsRes = await fetch(`${base}/accounts`);
  const accountsBody = await accountsRes.json();
  check('GET /accounts is handled by the extracted route',
    accountsRes.status === 200 && accountsBody.accounts?.[0]?.alias === 'alpha');

  await fetch(`${base}/quota`);
  await fetch(`${base}/quota`);
  check('GET /quota reuses a fresh per-account cache entry', quotaFetches === 1);
  await fetch(`${base}/quota?refresh=1`);
  check('GET /quota refresh bypasses the cache', quotaFetches === 2);

  const renameRes = await fetch(`${base}/accounts/alpha/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newAlias: 'renamed' }),
  });
  const renameBody = await renameRes.json();
  check('POST rename maps success and reconciles the pool',
    renameRes.status === 200 && renameBody.ok === true && pool.get('renamed') && !pool.get('alpha'));
  check('successful rename schedules plan discovery', probes === 1);

  const invalidRes = await fetch(`${base}/accounts/renamed/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  check('malformed rename JSON returns 400', invalidRes.status === 400);

  const largeRes = await fetch(`${base}/accounts/renamed/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newAlias: `a${'b'.repeat(9_000)}` }),
  });
  check('oversized rename payload returns 413', largeRes.status === 413);

  const timeoutStatus = await new Promise((resolve) => {
    const req = httpRequest(`${base}/accounts/renamed/rename`, {
      method: 'POST',
      headers: { 'Content-Length': '100', 'Content-Type': 'application/json' },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', (error) => resolve(error));
    req.write('{');
  });
  check('slow rename body receives 408 before socket teardown', timeoutStatus === 408);

  deps.isLoopbackAddress = () => false;
  const forbiddenRes = await fetch(`${base}/accounts/renamed`, { method: 'DELETE' });
  check('remote account mutation is rejected before touching storage', forbiddenRes.status === 403);
  deps.isLoopbackAddress = () => true;

  await writeFile(join(getAccountsDir(), 'corrupt.json'), '{', { mode: 0o600 });
  const internalRes = await fetch(`${base}/accounts/corrupt/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newAlias: 'recovered' }),
  });
  check('storage failures are reported as 500 rather than not-found', internalRes.status === 500);

  const deleteRes = await fetch(`${base}/accounts/renamed`, { method: 'DELETE' });
  check('DELETE removes and reconciles an account', deleteRes.status === 200 && pool.size === 0);
  check('mutations performed reconciliation', reconciles >= 3);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
