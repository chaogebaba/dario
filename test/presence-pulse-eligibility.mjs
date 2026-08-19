#!/usr/bin/env bun
// The session presence heartbeat must not pulse with a benched account's token.
//
// `pool.all()` returns every configured account, disabled ones included —
// disabling is a ROUTING decision, not a removal, and the diagnostics depend on
// benched seats staying visible. The heartbeat picked `all()[0]`. The pool is a
// Map in reconcile insertion order, so index 0 is whichever account loaded
// first, which has nothing to do with whether it may serve.
//
// On a pool whose first account is disabled the proxy kept POSTing
// /v1/code/sessions/<id>/client/presence with that seat's bearer token every
// 5s — the exact traffic the operator benched it to stop — and left no trace,
// because the pulse is out of band and never reaches the request log.
//
// Every other `pool.all()` consumer in proxy.ts already filtered on `enabled`.
// This one did not, and was correct on the audit machine only because the
// disabled account happened to load second.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AccountPool } from '../dist/pool.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
}
function header(name) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'proxy.ts'), 'utf-8');

// ======================================================================
header('pool.all() — what it contains, and what position tells you');
{
  const seat = (alias, enabled) => ({
    accessToken: `token-${alias}`,
    refreshToken: `refresh-${alias}`,
    expiresAt: Date.now() + 3_600_000,
    deviceId: `device-${alias}`,
    accountUuid: `uuid-${alias}`,
    enabled,
  });

  // Insertion order puts the benched seat first — the ordering the live bug
  // needed, and the one an operator produces just by disabling their oldest
  // account.
  const pool = new AccountPool('headroom');
  pool.add('benched', seat('benched', false));
  pool.add('live', seat('live', true));

  check('all() still returns disabled accounts', pool.all().length === 2);
  check('a disabled account can occupy index 0', pool.all()[0].enabled === false);
  check(
    'the positional pick would have pulsed with the benched seat',
    pool.all()[0].accessToken === 'token-benched',
  );
  check(
    'the eligibility-aware pick reaches past it to the live seat',
    pool.all().find((account) => account.enabled)?.accessToken === 'token-live',
  );

  // Ordering is the only thing that made the old code look correct, so pin
  // that the two selections genuinely disagree here.
  check(
    'the two selections disagree on this pool',
    pool.all()[0].accessToken !== pool.all().find((a) => a.enabled)?.accessToken,
  );

  // No eligible seat must mean no pulse, not a pulse with a benched token.
  const dark = new AccountPool('headroom');
  dark.add('benched', seat('benched', false));
  check(
    'an all-disabled pool yields no token, so the pulse is skipped entirely',
    (dark.all().find((account) => account.enabled)?.accessToken ?? '') === '',
  );

  // api-key mode: no pool accounts at all. Still no crash, still no pulse.
  check(
    'an empty pool yields no token',
    (new AccountPool('headroom').all().find((a) => a.enabled)?.accessToken ?? '') === '',
  );
}

// ======================================================================
header('proxy.ts — the heartbeat selects on eligibility, not position');
{
  // Narrow to the heartbeat so a match elsewhere in a 4800-line file cannot
  // satisfy these.
  const idx = src.indexOf('client/presence');
  check('the presence heartbeat is still there', idx > 0);
  const block = src.slice(Math.max(0, idx - 2000), idx + 200);

  check(
    'the heartbeat token comes from find(enabled), not from index 0',
    /pool\.all\(\)\.find\(\(account\) => account\.enabled\)\?\.accessToken/.test(block),
  );
  check(
    'it still bails rather than pulsing unauthenticated',
    /if \(!token\) return;/.test(block),
  );

  // The bug class, not just the instance: the pool has no meaningful order, so
  // indexing into it positionally is never the right way to choose a seat.
  check(
    'no positional index into pool.all() remains anywhere in the proxy',
    !/pool\.all\(\)\[\d+\]/.test(src),
  );
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
