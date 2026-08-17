#!/usr/bin/env bun

// Integration contract: body-derived session identity must be resolved before
// the proxy commits a pool selection. This catches timing regressions that
// extraction and AccountPool unit tests cannot observe independently.

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0;
let fail = 0;
function check(label, condition) {
  if (condition) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`); }
}

const home = await mkdtemp(join(tmpdir(), 'dario-affinity-proxy-'));
process.env.HOME = home;
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';
const accountsDir = join(home, '.dario', 'accounts');
await mkdir(accountsDir, { recursive: true });
for (const alias of ['alpha', 'beta']) {
  await writeFile(join(accountsDir, `${alias}.json`), JSON.stringify({
    alias,
    accessToken: `token-${alias}`,
    refreshToken: `refresh-${alias}`,
    expiresAt: Date.now() + 8 * 60 * 60_000,
    scopes: ['user:inference'],
    deviceId: `device-${alias}`,
    accountUuid: `account-${alias}`,
  }));
}

const realFetch = globalThis.fetch;
const upstreamAccounts = [];
const fakeFetch = async (url, init) => {
  if (String(url).includes('/api/oauth/profile')) {
    return new Response(JSON.stringify({ account: { has_claude_max: true } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (String(url).includes('/v1/messages')) {
    const headers = new Headers(init?.headers);
    const authorization = headers.get('authorization') ?? '';
    upstreamAccounts.push(authorization.includes('token-alpha') ? 'alpha'
      : authorization.includes('token-beta') ? 'beta' : 'unknown');
  }
  return new Response(JSON.stringify({
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
    content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
      'anthropic-ratelimit-unified-7d-utilization': '0.1',
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    },
  });
};
globalThis.fetch = fakeFetch;

const { startProxy } = await import('../dist/proxy.js');
const PORT = 39874;
const BASE = `http://127.0.0.1:${PORT}`;
await startProxy({
  port: PORT,
  host: '127.0.0.1',
  fetchImpl: fakeFetch,
  poolStrategy: 'round-robin',
  sessionAffinity: true,
  pacingMinMs: 0,
  pacingJitterMs: 0,
  noLiveCapture: true,
  overageGuardEnabled: false,
});
for (let i = 0; i < 50; i++) {
  try { await realFetch(`${BASE}/health`); break; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
}

async function send(sessionId) {
  const response = await realFetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': 'dario',
      // Simulate a coarse intermediary header. Claude metadata must win.
      'x-session-id': 'shared-intermediary-session',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 8,
      metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  await response.text();
  return response.status;
}

const statuses = [await send('session-a'), await send('session-b'), await send('session-a')];
check('all integration requests succeeded', statuses.every((status) => status === 200));
check('fresh body sessions rotate and a repeated session remains pinned',
  upstreamAccounts.slice(-3).join(',') === 'alpha,beta,alpha');

const report = await (await realFetch(`${BASE}/routing/trace?limit=10`)).json();
const events = report.events.filter((event) => event.model === 'claude-opus-4-8');
check('routing trace retained all three decisions', events.length === 3);
check('routing trace selected exact Claude body provenance',
  events.every((event) => event.affinity.source === 'body:metadata.user_id.session_id'));
check('repeat is an affinity hit while fresh sessions are new bindings',
  events.filter((event) => event.affinity.result === 'new').length === 2
    && events.filter((event) => event.affinity.result === 'hit').length === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
