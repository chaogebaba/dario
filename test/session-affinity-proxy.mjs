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
const upstreamBodies = [];
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
    const rawBody = init?.body;
    const bodyText = typeof rawBody === 'string'
      ? rawBody
      : ArrayBuffer.isView(rawBody)
        ? Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength).toString('utf8')
        : '';
    upstreamBodies.push(JSON.parse(bodyText));
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
  sessionAffinityClaudeSource: 'body',
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
      // CPA can reuse this header across terminals. Body metadata must win.
      'x-claude-code-session-id': 'shared-cpa-session',
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

const HEADROOM_PORT = 39875;
const HEADROOM_BASE = `http://127.0.0.1:${HEADROOM_PORT}`;
await startProxy({
  port: HEADROOM_PORT,
  host: '127.0.0.1',
  fetchImpl: fakeFetch,
  poolStrategy: 'headroom',
  sessionAffinity: true,
  sessionAffinityClaudeSource: 'body',
  pacingMinMs: 0,
  pacingJitterMs: 0,
  noLiveCapture: true,
  overageGuardEnabled: false,
});
for (let i = 0; i < 50; i++) {
  try { await realFetch(`${HEADROOM_BASE}/health`); break; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
}

async function sendHeadroom(sessionId) {
  const response = await realFetch(`${HEADROOM_BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': 'dario',
      'x-claude-code-session-id': 'shared-cpa-session',
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

const headroomStatuses = [
  await sendHeadroom('headroom-session-a'),
  await sendHeadroom('headroom-session-b'),
  await sendHeadroom('headroom-session-a'),
  await sendHeadroom('headroom-session-b'),
];
const headroomReport = await (await realFetch(`${HEADROOM_BASE}/routing/trace?limit=10`)).json();
const headroomEvents = headroomReport.events.filter((event) => event.model === 'claude-opus-4-8');
check('headroom requests with distinct body sessions succeed',
  headroomStatuses.every((status) => status === 200));
check('headroom creates one binding per body session and reuses each binding',
  headroomEvents.filter((event) => event.affinity.result === 'new').length === 2
    && headroomEvents.filter((event) => event.affinity.result === 'hit').length === 2);
check('headroom keeps distinct session fingerprints independent',
  headroomEvents.length === 4
    && headroomEvents[0].affinity.fingerprint !== headroomEvents[1].affinity.fingerprint
    && headroomEvents[0].affinity.fingerprint === headroomEvents[2].affinity.fingerprint
    && headroomEvents[1].affinity.fingerprint === headroomEvents[3].affinity.fingerprint);

async function sendGenuineClaudeCode(sessionId, assistantContent, model = 'claude-fable-5') {
  const callback = '<system-reminder><task-notification><summary>Agent finished</summary></task-notification></system-reminder>';
  const response = await realFetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': 'dario',
      'x-claude-code-session-id': 'shared-cpa-session',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8,
      system: [
        { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.234;' },
        { type: 'text', text: 'You are a Claude agent, built on the Claude Agent SDK.' },
      ],
      metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'delegate this task' }] },
        { role: 'system', content: '<total_tokens>100</total_tokens>' },
        { role: 'assistant', content: assistantContent },
        { role: 'user', content: [{ type: 'text', text: callback }] },
      ],
    }),
  });
  await response.text();
  return { status: response.status, callback };
}

async function sendGenuineTrailingAssistant(sessionId) {
  const response = await realFetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': 'dario',
      'x-claude-code-session-id': 'shared-cpa-session',
    },
    body: JSON.stringify({
      model: 'claude-fable-5',
      max_tokens: 8,
      system: [
        { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.234;' },
        { type: 'text', text: 'You are a Claude agent, built on the Claude Agent SDK.' },
      ],
      metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'continue the interrupted task' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'The partial result is' }] },
      ],
    }),
  });
  await response.text();
  return response.status;
}

const thinkingTail = await sendGenuineClaudeCode('callback-thinking', [
  { type: 'thinking', thinking: 'waiting' },
  { type: 'text', text: 'Waiting for the result.' },
]);
const textTail = await sendGenuineClaudeCode('callback-text', [
  { type: 'text', text: 'Waiting for the result.' },
]);
const unsupportedSystem = await sendGenuineClaudeCode('callback-sonnet', [
  { type: 'text', text: 'Waiting for the result.' },
], 'claude-sonnet-4-6');
const callbackBodies = upstreamBodies.slice(-3);
check('genuine CC callback requests succeed through the proxy path',
  thinkingTail.status === 200 && textTail.status === 200 && unsupportedSystem.status === 200);
check('genuine CC callback remains the final user turn for both assistant shapes',
  callbackBodies.every((body) => body.messages.at(-1)?.role === 'user'));
check('genuine CC callback content reaches upstream structurally unchanged',
  callbackBodies[0]?.messages.at(-1)?.content[0]?.text === thinkingTail.callback
    && callbackBodies[1]?.messages.at(-1)?.content[0]?.text === textTail.callback
    && callbackBodies[2]?.messages.at(-1)?.content[0]?.text === unsupportedSystem.callback);
check('supported Fable preserves native system turns',
  callbackBodies.slice(0, 2).every((body) => body.messages.some((message) => message.role === 'system')));
check('unsupported Sonnet folds system turns into user content',
  callbackBodies[2]?.messages.every((message) => message.role !== 'system'));

const trailingStatus = await sendGenuineTrailingAssistant('callback-trailing-assistant');
const trailingBody = upstreamBodies.at(-1);
check('genuine CC trailing assistant request succeeds', trailingStatus === 200);
check('trailing assistant history is preserved with a continuation user turn',
  trailingBody?.messages.at(-2)?.role === 'assistant'
    && trailingBody?.messages.at(-1)?.role === 'user'
    && trailingBody?.messages.at(-1)?.content[0]?.text === 'Please continue where you left off.');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
