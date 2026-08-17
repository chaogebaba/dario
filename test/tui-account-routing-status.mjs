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
process.exit(ok ? 0 : 1);
