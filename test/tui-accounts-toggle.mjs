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
const press = (ch, shift = false) =>
  reduceAccountsKey(state, { name: 'printable', ch, ctrl: false, shift, meta: false });

const next = press('t');
check('t starts a toggle', next?.pendingAction?.type === 'toggle');
check('toggle action carries the selected row', next?.pendingAction?.alias === 'gamma');
check('toggle action preserves selected index', next?.pendingAction?.selectedIdx === 2);

// The action now names the state to move to, decided off the row on screen.
// The route it drives sets that state rather than inverting whatever the
// server finds, so a retried request lands where the operator pointed.
check('toggle action names the state to move to', next?.pendingAction?.enabled === false);
const off = reduceAccountsKey(
  { ...state, accounts: state.accounts.map((a, i) => (i === 2 ? { ...a, enabled: false } : a)) },
  { name: 'printable', ch: 't', ctrl: false, shift: false, meta: false },
);
check('a disabled row asks to be enabled', off?.pendingAction?.enabled === true);
const on = reduceAccountsKey(
  { ...state, accounts: state.accounts.map((a, i) => (i === 2 ? { ...a, enabled: true } : a)) },
  { name: 'printable', ch: 't', ctrl: false, shift: false, meta: false },
);
check('an enabled row asks to be disabled', on?.pendingAction?.enabled === false);
// `enabled` is optional on the row and absent means enabled, which is the
// shape every account had before the flag existed.
check('a row with no flag counts as enabled, so t asks to disable it',
  next?.pendingAction?.enabled === false);

// This used to be `ch.toLowerCase() === 't'` — the only key on the tab matched
// case-insensitively. `d` and `x` are exact AND put a y/n confirm in the way;
// `t` was neither, so shift-T returned a deliberately benched account to
// routing, and to billing, in one keystroke.
check('uppercase T does nothing', press('T', true) === undefined);

console.log(`\ntui-accounts-toggle: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
