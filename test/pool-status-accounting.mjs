// A2 — `status()` counted disabled accounts as exhausted quota.
//
// `exhausted` was `accounts - healthy`, and `healthy` is gated on
// `ineligibleReason`, which reports 'disabled' first. So switching an account
// off moved it straight into the quota bucket: the operator's own deliberate
// act came back as "this seat is spent", on a token with hours left and a
// rate-limit window sitting at zero. Proven live before the fix by toggling a
// seat with a valid 7.8 h token — healthy 2→1, exhausted 1→2.
//
// The invariant this suite pins is that each number names exactly one cause
// and they add up: healthy + exhausted + disabled === accounts.

import { AccountPool } from '../dist/pool.js';

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

const HOUR = 3600_000;
function creds(overrides = {}) {
  return {
    accessToken: 't', refreshToken: 'r',
    expiresAt: Date.now() + 8 * HOUR,
    deviceId: 'd', accountUuid: 'u',
    ...overrides,
  };
}

// ======================================================================
header('a disabled seat is disabled, not exhausted');
{
  const pool = new AccountPool();
  pool.add('live', creds());
  pool.add('benched', creds({ enabled: false }));

  const st = pool.status();
  check('the live seat is the only healthy one', st.healthy === 1);
  check('the benched seat is counted as disabled', st.disabled === 1);
  check('and NOT as exhausted quota', st.exhausted === 0);
  check('accounts still counts both', st.accounts === 2);
}

// ======================================================================
header('a drained seat is still exhausted — the fix does not swallow the real cause');
{
  const pool = new AccountPool();
  pool.add('live', creds());
  pool.add('dead', creds({ expiresAt: Date.now() - 1000 }));

  const st = pool.status();
  check('healthy counts the live seat', st.healthy === 1);
  check('the expired seat is exhausted', st.exhausted === 1);
  check('nothing is reported disabled', st.disabled === 0);
}

// ======================================================================
header('both causes at once, told apart');
{
  const pool = new AccountPool();
  pool.add('live', creds());
  pool.add('dead', creds({ expiresAt: Date.now() - 1000 }));
  pool.add('benched', creds({ enabled: false }));
  // A disabled AND expired seat: `ineligibleReason` reports 'disabled' first,
  // so it must land in the disabled bucket rather than being double-counted.
  pool.add('benched-and-dead', creds({ enabled: false, expiresAt: Date.now() - 1000 }));

  const st = pool.status();
  check('one healthy', st.healthy === 1);
  check('one exhausted', st.exhausted === 1);
  check('two disabled', st.disabled === 2);
  check('nothing is counted twice', st.healthy + st.exhausted + st.disabled === st.accounts);
}

// ======================================================================
header('the sum holds for the degenerate pools too');
{
  const empty = new AccountPool();
  const st0 = empty.status();
  check('empty pool sums to zero', st0.healthy + st0.exhausted + st0.disabled === st0.accounts && st0.accounts === 0);
  check('empty pool reports no exhaustion', st0.exhausted === 0 && st0.disabled === 0);

  const allOff = new AccountPool();
  allOff.add('a', creds({ enabled: false }));
  allOff.add('b', creds({ enabled: false }));
  const st1 = allOff.status();
  check('an all-disabled pool reports 0 exhausted', st1.exhausted === 0);
  check('an all-disabled pool reports every seat disabled', st1.disabled === 2);
  check('and none healthy', st1.healthy === 0);
  check('the sum still holds', st1.healthy + st1.exhausted + st1.disabled === st1.accounts);

  const allDead = new AccountPool();
  allDead.add('a', creds({ expiresAt: Date.now() - 1000 }));
  const st2 = allDead.status();
  check('an all-expired pool still reports exhaustion', st2.exhausted === 1 && st2.disabled === 0);
  check('the sum still holds', st2.healthy + st2.exhausted + st2.disabled === st2.accounts);
}

// ======================================================================
header('the neighbouring fields are unchanged by the split');
{
  const pool = new AccountPool();
  pool.add('live', creds());
  pool.add('benched', creds({ enabled: false }));

  const st = pool.status();
  // totalHeadroom already averaged over enabled accounts only — that was
  // deliberate and is the half of these two lines that was right.
  check('totalHeadroom still ignores the disabled seat', st.totalHeadroom === 100);
  check('bestAccount is the live seat', st.bestAccount === 'live');
  check('status() does not consume a round-robin turn', pool.status().bestAccount === 'live');
}

console.log(`\n${'='.repeat(70)}\n  ${pass} pass, ${fail} fail\n${'='.repeat(70)}`);
process.exit(fail === 0 ? 0 : 1);
