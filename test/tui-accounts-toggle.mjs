#!/usr/bin/env bun

import { initialAccountsState, reduceAccountsKey } from '../dist/tui/accounts-state.js';

let pass = 0;
let fail = 0;
function check(label, condition) {
  if (condition) { console.log(`  PASS ${label}`); pass++; }
  else { console.log(`  FAIL ${label}`); fail++; }
}

const state = {
  ...initialAccountsState(),
  loading: false,
  accounts: [
    { alias: 'alpha', expiresAt: Date.now() + 60_000 },
    { alias: 'beta', expiresAt: Date.now() + 60_000 },
    { alias: 'gamma', expiresAt: Date.now() + 60_000 },
  ],
  selectedIdx: 2,
};
const next = reduceAccountsKey(state, { name: 'printable', ch: 'T', ctrl: false, shift: true, meta: false });
check('uppercase T starts a toggle', next?.pendingAction?.type === 'toggle');
check('toggle action carries the selected row', next?.pendingAction?.alias === 'gamma');
check('toggle action preserves selected index', next?.pendingAction?.selectedIdx === 2);

console.log(`\ntui-accounts-toggle: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
