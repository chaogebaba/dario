#!/usr/bin/env bun

import { renderAccounts } from '../dist/tui/accounts-render.js';

const rendered = renderAccounts({
  loading: false,
  accounts: [{
    alias: 'pro-seat',
    expiresAt: Date.now() + 3_600_000,
    status: 'quota-cooldown',
    quota: {
      windows: [],
      plan: 'Pro',
      email: null,
    },
  }],
  source: 'pool',
  error: null,
  selectedIdx: 0,
  mode: 'normal',
  editBuffer: null,
  message: null,
  messageKind: null,
  authorizeUrl: null,
  pendingAction: null,
}, { cols: 120, rows: 30 });

const plain = rendered.replace(/\x1b\[[0-9;]*m/g, '');
const ok = plain.includes('Plan Pro') && plain.includes('quota-cooldown');
console.log(`${ok ? 'PASS' : 'FAIL'} plan and routing status render together`);

const emailRendered = renderAccounts({
  loading: false,
  accounts: [{
    alias: 'claudeMax',
    expiresAt: Date.now() + 3_600_000,
    quota: { windows: [], plan: 'Max', email: 'owner@example.com' },
  }],
  source: 'pool', error: null, selectedIdx: 0, mode: 'normal', editBuffer: null,
  message: null, messageKind: null, authorizeUrl: null, pendingAction: null,
}, { cols: 140, rows: 30 }).replace(/\x1b\[[0-9;]*m/g, '');
const emailOk = emailRendered.includes('claudeMax  email owner@example.com');
console.log(`${emailOk ? 'PASS' : 'FAIL'} account email renders as a labeled column`);

const hostile = renderAccounts({
  loading: false,
  accounts: [{
    alias: 'safe-alias',
    expiresAt: Date.now() + 3_600_000,
    status: 'unknown',
    quota: {
      windows: [{ id: 'hostile', label: 'quota\u001b[2J\nlabel', remainingPercent: 50, resetsAt: null }],
      plan: 'Pro\u001b[999m',
      email: 'safe@example.com\n\u001b[2J',
      error: 'error\u001b[2J\ntext',
    },
  }],
  source: 'pool', error: null, selectedIdx: 0, mode: 'normal', editBuffer: null,
  message: 'message\u001b[2J\ntext', messageKind: 'error', authorizeUrl: null, pendingAction: null,
}, { cols: 120, rows: 30 });
const safe = !hostile.includes('\u001b[999m') && !hostile.includes('\u001b[2J') && !hostile.includes('\ntext');
console.log(`${safe ? 'PASS' : 'FAIL'} account data and errors cannot inject terminal controls`);

const manyAccounts = Array.from({ length: 8 }, (_, index) => ({
  alias: `seat-${index}`,
  expiresAt: Date.now() + 3_600_000,
}));
const windowed = renderAccounts({
  loading: false,
  accounts: manyAccounts,
  source: 'pool', error: null, selectedIdx: 7, mode: 'normal', editBuffer: null,
  message: null, messageKind: null, authorizeUrl: null, pendingAction: null,
}, { cols: 100, rows: 10 }).replace(/\x1b\[[0-9;]*m/g, '');
const selectedVisible = windowed.includes('> seat-7') && !windowed.includes('> seat-0');
console.log(`${selectedVisible ? 'PASS' : 'FAIL'} account window keeps the selected row visible`);

process.exit(ok && emailOk && safe && selectedVisible ? 0 : 1);
