#!/usr/bin/env bun
// Surface agreement — every place that reports on one account must report the
// same thing the router decided.
//
// dario has four surfaces that answer "can the pool serve" and three that
// answer "can this account serve". The first four were unified in 7eedd13
// after they were caught disagreeing in both directions at once. This suite
// covers the second group, and is written as a sweep rather than a list of
// cases because the pool-level bug survived three months of code review: what
// nobody spots by reading is a surface that agrees on the eight states someone
// thought to write down and diverges on the ninth.
//
// So the states are generated. Every combination of enabled × expiry × auth
// cool-down × rate-limit cool-down × refresh error × last-known quota status
// becomes an account in one pool, and each surface is driven for real — an
// HTTP GET against the route handler, not a call to the mapper it happens to
// use today. A surface that stops sharing the predicate fails here even if it
// still typechecks.
//
// The invariant is not "identical output". These surfaces legitimately word
// things differently and carry different fields. It is: whether an account
// will serve is the router's call, every surface reports that same call, and
// no surface names a cause the router did not name.

import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  OK ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? '\n       ' + detail : ''}`); }
}
function header(n) { console.log(`\n${'='.repeat(70)}\n  ${n}\n${'='.repeat(70)}`); }

const home = await mkdtemp(join(tmpdir(), 'dario-surface-agreement-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';

const { handleAccountRoute } = await import('../dist/account-routes.js');
const { handleAdminRequest } = await import('../dist/admin-api.js');
const { adminAccountSnapshot } = await import('../dist/proxy.js');
const {
  AccountPool, EMPTY_SNAPSHOT, accountAvailability, authCooldownMs,
  blockedSummary, ineligibleReason, poolVerdict,
} = await import('../dist/pool.js');
const { poolRoutingCheck } = await import('../dist/doctor.js');

const NOW = Date.now();
const HOUR = 3_600_000;

// ── the state space ───────────────────────────────────────────────────────
//
// Each axis is one thing that can independently be true of an account. The
// product is what the surfaces actually have to agree about; picking cases by
// hand is what let `expired + auth-cooldown` — where the two surfaces name
// different causes for the same account — go unnoticed.
const AXES = {
  enabled: {
    on: {},
    off: { enabled: false },
  },
  expiry: {
    live: { expiresAt: NOW + HOUR },
    // Inside select()'s 30s slack: a token that expires mid-flight is no use,
    // and this is the state the row renders in green.
    edge: { expiresAt: NOW + 10_000 },
    gone: { expiresAt: NOW - HOUR },
  },
  auth: {
    clean: {},
    cooling: { lastAuthFailureAt: NOW - 1_000, consecutiveAuthFailures: 1 },
    lapsed: { lastAuthFailureAt: NOW - authCooldownMs(1) - 60_000, consecutiveAuthFailures: 1 },
  },
  rl: {
    clear: {},
    global: { rateLimitCooldowns: { '*': { until: NOW + 60_000, backoffLevel: 1 } } },
    // Scoped to one model family. The router asked with no family will serve
    // this account; a surface that treats any cooldown entry as a block will
    // not, and that difference is invisible until someone hits a 429 on one
    // family only.
    scoped: { rateLimitCooldowns: { sonnet: { until: NOW + 60_000, backoffLevel: 1 } } },
    expiredCooldown: { rateLimitCooldowns: { '*': { until: NOW - 1_000, backoffLevel: 1 } } },
  },
  refresh: {
    ok: {},
    failed: { refreshError: 'invalid_grant' },
  },
  quota: {
    unknown: { rateLimit: { ...EMPTY_SNAPSHOT, status: 'unknown' } },
    allowed: { rateLimit: { ...EMPTY_SNAPSHOT, status: 'allowed' } },
    rejected: { rateLimit: { ...EMPTY_SNAPSHOT, status: 'rejected' } },
  },
};

const states = [];
for (const [enabled, a] of Object.entries(AXES.enabled))
  for (const [expiry, b] of Object.entries(AXES.expiry))
    for (const [auth, c] of Object.entries(AXES.auth))
      for (const [rl, d] of Object.entries(AXES.rl))
        for (const [refresh, e] of Object.entries(AXES.refresh))
          for (const [quota, f] of Object.entries(AXES.quota))
            states.push({
              name: `${enabled}/${expiry}/${auth}/${rl}/${refresh}/${quota}`,
              alias: `a${states.length}`,
              over: { ...a, ...b, ...c, ...d, ...e, ...f },
            });

// `add()` takes credentials; the cool-down and refresh fields are runtime
// state it deliberately preserves rather than accepts, so they go on after.
const pool = new AccountPool();
for (const s of states) {
  pool.add(s.alias, {
    accessToken: 't', refreshToken: 'r', expiresAt: NOW + HOUR,
    deviceId: 'd', accountUuid: `u-${s.alias}`,
  });
  Object.assign(pool.get(s.alias), s.over);
}

// ── drive the surfaces ────────────────────────────────────────────────────
const deps = {
  pool, quotaCache: new Map(), quotaCacheMs: 60_000, mutationBodyTimeoutMs: 50,
  jsonHeaders: { 'Content-Type': 'application/json' },
  isLoopbackAddress: () => true,
  reconcile: async () => pool.size,
  retryModelCatalog: () => {}, probePlans: () => {},
  fetchQuota: async () => ({ windows: [], plan: 'Max', email: null, extraUsage: null, fetchedAt: Date.now() }),
};

const server = createServer(async (req, res) => {
  if (!await handleAccountRoute(req, res, req.url?.split('?')[0] ?? '', deps)) { res.writeHead(404); res.end(); }
});

let publicRows, adminRows;
try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = await (await fetch(`${base}/accounts`)).json();
  publicRows = new Map(body.accounts.map((a) => [a.alias, a]));

  const TOKEN = Buffer.from('surface-agreement-token');
  const req = new EventEmitter();
  req.method = 'GET'; req.url = '/admin/accounts';
  req.headers = { authorization: `Bearer ${TOKEN}` };
  req.destroy = () => {};
  setImmediate(() => req.emit('end'));
  const res = {
    statusCode: 0, body: '',
    writeHead(s) { this.statusCode = s; return this; },
    end(b) { this.body = b || ''; return this; },
  };
  await handleAdminRequest(req, res, '/admin/accounts', {
    adminTokenBuf: TOKEN,
    listAccounts: async () => pool.all().map((a) => ({ alias: a.alias, scopes: [], expiresAt: a.expiresAt })),
    poolStatus: () => adminAccountSnapshot(pool.all()),
  });
  adminRows = new Map(JSON.parse(res.body).accounts.map((a) => [a.alias, a]));
} finally {
  await new Promise((r) => server.close(r));
}

// Labels that assert the account cannot be routed to. `refresh-failed` is
// deliberately absent: it is a warning on an account that still serves.
const BLOCKING = new Set(['disabled', 'expired', 'auth-cooldown', 'quota-cooldown']);
const LABEL = { disabled: 'disabled', expired: 'expired', 'auth-cooldown': 'auth-cooldown', 'rate-limited': 'quota-cooldown' };

/** One summarised assertion over the whole sweep, naming the first few failures. */
function sweep(label, predicate) {
  const bad = [];
  for (const s of states) {
    const account = pool.get(s.alias);
    const ctx = {
      state: s.name,
      account,
      router: ineligibleReason(account),
      shared: accountAvailability(account),
      pub: publicRows.get(s.alias),
      adm: adminRows.get(s.alias),
    };
    if (!predicate(ctx)) bad.push(`${s.name}  router=${ctx.router}  /accounts=${ctx.pub?.status}/${ctx.pub?.serving}  /admin=${ctx.adm?.status}/${ctx.adm?.serving}`);
  }
  check(`${label} — all ${states.length} states`, bad.length === 0,
    bad.length ? `${bad.length} failing, first ${Math.min(3, bad.length)}:\n       ` + bad.slice(0, 3).join('\n       ') : '');
}

// ======================================================================
header(`Per-account surfaces (${states.length} generated states)`);

check('every generated state reached both surfaces',
  states.every((s) => publicRows.has(s.alias) && adminRows.has(s.alias)));

sweep('GET /accounts reports the router\'s own routability',
  (c) => c.pub.serving === (c.router === null));

sweep('GET /admin/accounts reports the same routability',
  (c) => c.adm.serving === (c.router === null));

sweep('both surfaces show the same status string',
  (c) => c.pub.status === c.adm.status);

sweep('a blocked account is labelled with the reason the router gave',
  (c) => c.router === null || c.pub.status === LABEL[c.router]);

sweep('a serving account never wears a blocking label',
  (c) => c.router !== null || !BLOCKING.has(c.pub.status));

sweep('the shared verdict is what both surfaces published',
  (c) => c.shared.status === c.pub.status && c.shared.serving === c.pub.serving);

sweep('GET /admin/accounts no longer hides whether an account is switched off',
  (c) => c.adm.enabled === (c.account.enabled !== false));

// ======================================================================
header('Per-account agrees with the pool-level verdict');
{
  // The bridge between this suite and pool-verdict.mjs: a pool holding
  // exactly one account can serve if and only if that account can.
  const bad = [];
  for (const s of states) {
    const one = new AccountPool();
    one.add('solo', { accessToken: 't', refreshToken: 'r', expiresAt: NOW + HOUR, deviceId: 'd', accountUuid: 'u' });
    Object.assign(one.get('solo'), s.over);
    const account = one.get('solo');
    const serving = ineligibleReason(account) === null;
    const verdict = one.verdict();
    const doctor = poolRoutingCheck(verdict, one.status(), one.select()?.alias ?? null);
    if (verdict.state !== (serving ? 'serving' : 'blocked')) bad.push(`${s.name}: verdict=${verdict.state}`);
    else if ((one.select() !== null) !== serving) bad.push(`${s.name}: select()`);
    else if ((doctor.status === 'info') !== serving) bad.push(`${s.name}: doctor=${doctor.status}`);
    // The pool's reason set must contain the account's, and the summary must
    // say something. The wording deliberately differs — `blockedSummary`
    // writes prose ("in auth cool-down") where the row carries the wire name
    // (`auth-cooldown`) — so the assertion is on the reason, not the string.
    else if (!serving && (!verdict.reasons.includes(accountAvailability(account).blockedBy) || blockedSummary(verdict) === '')) {
      bad.push(`${s.name}: verdict reasons [${verdict.reasons}] omit ${accountAvailability(account).blockedBy}`);
    }
  }
  check(`a one-account pool serves exactly when its account does — all ${states.length} states`,
    bad.length === 0, bad.slice(0, 3).join('\n       '));
}

// ======================================================================
header('The five disagreements this suite was written for');
{
  const row = (over) => {
    const p = new AccountPool();
    p.add('x', { accessToken: 't', refreshToken: 'r', expiresAt: NOW + HOUR, deviceId: 'd', accountUuid: 'u' });
    Object.assign(p.get('x'), { rateLimit: { ...EMPTY_SNAPSHOT, status: 'unknown' }, ...over });
    return { account: p.get('x'), ...accountAvailability(p.get('x')), admin: adminAccountSnapshot(p.all()).get('x') };
  };

  // 1. An expired account was listed as `unknown` — the never-measured status,
  //    which the TUI renders as no status at all — while the router refused it.
  const expired = row({ expiresAt: NOW - HOUR });
  check('an expired account is called expired, not `unknown`', expired.status === 'expired' && expired.serving === false);

  // 2. Same for one expiring inside select()'s 30s window, which additionally
  //    renders its remaining time in green.
  const edge = row({ expiresAt: NOW + 10_000 });
  check('an account expiring inside the 30s window is called expired', edge.status === 'expired' && edge.serving === false);

  // 3. `expired + auth-cooldown` is one account with two true statements about
  //    it. ineligibleReason documents at length why the expiry is the one to
  //    report — it is the cause the operator can act on, and it is upstream of
  //    the cool-down that the first doomed request provokes. GET /accounts
  //    reported the cool-down.
  const both = row({ expiresAt: NOW - HOUR, lastAuthFailureAt: NOW - 1_000, consecutiveAuthFailures: 1 });
  check('expiry outranks the cool-down it caused, on the row as well as in the router',
    both.status === 'expired');

  // 4. The admin API reported `auth-cooldown` or nothing. A disabled account
  //    came back as whatever upstream last said about quota, and `enabled` was
  //    computed for the login-start filter and then dropped from the response.
  const off = row({ enabled: false });
  check('the admin API says a disabled account is disabled', off.admin.status === 'disabled' && off.admin.serving === false);
  check('and publishes the flag it already had', off.admin.enabled === false);

  // 5. A cool-down scoped to one model family is not a block at global scope.
  //    Treating any cooldown entry as one benched an account the router would
  //    have used.
  const scoped = row({ rateLimitCooldowns: { sonnet: { until: NOW + 60_000, backoffLevel: 1 } } });
  check('a family-scoped cool-down does not bench the account globally',
    scoped.serving === true && !BLOCKING.has(scoped.status));

  // The one status a serving account may wear: the token works, the router
  // will use it, and renewal is broken so it will not survive its own expiry.
  const stale = row({ refreshError: 'invalid_grant' });
  check('a failed refresh is a warning on a serving account, not a block',
    stale.serving === true && stale.status === 'refresh-failed');
  const staleAndOff = row({ refreshError: 'invalid_grant', enabled: false });
  check('and it yields to an actual routing block', staleAndOff.status === 'disabled');
}

await rm(home, { recursive: true, force: true });
console.log(`\n${'='.repeat(70)}\n  ${pass} pass, ${fail} fail\n${'='.repeat(70)}`);
process.exit(fail === 0 ? 0 : 1);
