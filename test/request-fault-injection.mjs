#!/usr/bin/env bun

// Faults on the REQUEST side of the proxy.
//
// test/stream-fault-injection.mjs covers what happens when the upstream
// response goes wrong. Nothing covered what happens when the CLIENT does:
// hanging up mid-upload, sending a body that is not JSON, sending one that is
// truncated JSON, lying about content-length, or sending more than
// MAX_BODY_BYTES. Those all land in the window between the pool selection and
// the upstream call, which is the same window that owns a queue slot — so a
// mishandled one does not just answer badly, it can leak capacity.
//
// The split these settle, which was not obvious going in: dario adjudicates the
// faults that are ITS business and relays the ones that are Anthropic's.
//
//   * Oversized bodies and client hangups are dario's own — it answers 413
//     itself, and it never spends a pool token on a request that never finished
//     arriving. Forwarding either would bill the user for nothing.
//   * A body that is merely unparseable is NOT dario's call. It goes upstream
//     verbatim and Anthropic's verdict comes back untouched. That is asserted
//     rather than tolerated: a validator here would be a second, private
//     definition of what the Messages API accepts, and every point of
//     disagreement would be a request that works against api.anthropic.com and
//     fails against dario. The suite checks dario relays the upstream message
//     verbatim rather than substituting one of its own.
//
// Common to all of them: the error body stays Anthropic-shaped
// ({type:'error', error:{type, message}}) because clients parse it, and the
// queue drains back to zero so no fault costs capacity.

import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra !== undefined ? ` — ${extra}` : ''}`); }
}
function header(name) { console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`); }

const home = await mkdtemp(join(tmpdir(), 'dario-req-fault-'));
process.on('exit', () => rmSync(home, { recursive: true, force: true }));
process.env.HOME = home;
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';

const accountsDir = join(home, '.dario', 'accounts');
await mkdir(accountsDir, { recursive: true });
await writeFile(join(accountsDir, 'solo.json'), JSON.stringify({
  alias: 'solo',
  accessToken: 'token-solo',
  refreshToken: 'refresh-solo',
  expiresAt: Date.now() + 8 * 60 * 60_000,
  scopes: ['user:inference'],
  deviceId: 'device-solo',
  accountUuid: 'account-solo',
}));

const UPSTREAM_REJECT_MESSAGE = 'messages: field required';
let upstreamShouldReject = false;
let upstreamCalls = 0;
const fakeFetch = async (url, init) => {
  const u = String(url);
  if (u.includes('/oauth/profile')) {
    return new Response(JSON.stringify({ account: { has_claude_max: true } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.includes('/oauth/token')) {
    return new Response(JSON.stringify({
      access_token: 'token-solo', refresh_token: 'refresh-solo-2', expires_in: 28800,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.includes('/v1/messages')) {
    upstreamCalls++;
    if (upstreamShouldReject) {
      // What the real API answers a body it cannot use.
      return new Response(JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: UPSTREAM_REJECT_MESSAGE },
      }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      id: 'msg_ok', type: 'message', role: 'assistant', model: 'claude-haiku-4-5-20251001',
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};
globalThis.fetch = fakeFetch;

const { startProxy } = await import('../dist/proxy.js');
const proxy = await startProxy({ port: 0, fetchImpl: fakeFetch, verbose: false });

const BASE = { host: proxy.host, port: proxy.port, path: '/v1/messages', method: 'POST' };
const HDRS = {
  'content-type': 'application/json',
  'x-api-key': 'dario',
  'anthropic-version': '2023-06-01',
};


/** Send a complete body and read the whole response. */
function send(body, extraHeaders = {}, upstreamRejects = false) {
  upstreamShouldReject = upstreamRejects;
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(body);
    const req = request({ ...BASE, headers: { ...HDRS, 'content-length': payload.length, ...extraHeaders } }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({
        status: r.statusCode,
        headers: r.headers,
        body: Buffer.concat(chunks).toString(),
      }));
    });
    req.on('error', (e) => resolve({ status: null, error: e.code ?? e.message }));
    req.end(payload);
  });
}

/** Announce a body, send part of it, then hang up without finishing. */
function hangUpMidUpload(declaredLen, partial) {
  return new Promise((resolve) => {
    const req = request({ ...BASE, headers: { ...HDRS, 'content-length': declaredLen } }, (r) => {
      r.resume();
      r.on('end', () => resolve({ status: r.statusCode }));
    });
    req.on('error', () => resolve({ status: null, aborted: true }));
    req.write(partial);
    setTimeout(() => req.destroy(), 120);
  });
}

async function queueDepth() {
  const res = await fetch(`${proxy.url}/health`);
  const j = await res.json();
  return j.queue ?? {};
}

function parsed(res) {
  try { return JSON.parse(res.body); } catch { return null; }
}
function isAnthropicError(res) {
  const j = parsed(res);
  return !!j && j.type === 'error' && !!j.error && typeof j.error.type === 'string'
    && typeof j.error.message === 'string';
}

// A control, so a suite that rejects everything cannot pass by accident.
header('control — a well-formed request still succeeds');
{
  const before = upstreamCalls;
  const res = await send(JSON.stringify({
    model: 'claude-haiku-4-5-20251001', max_tokens: 16,
    messages: [{ role: 'user', content: 'hello' }],
  }));
  check('200', res.status === 200, res.status);
  check('reached upstream exactly once', upstreamCalls === before + 1);
}

// dario does NOT parse-and-reject on the client's behalf. A body it cannot
// understand is forwarded verbatim and Anthropic's own answer is relayed back.
// That is the right call for a proxy and it is asserted, not tolerated: a
// validator here would be a second, private definition of what the Messages API
// accepts, and every place it disagreed with the real one would be a request
// that works against api.anthropic.com and fails against dario. The fake
// upstream below answers 400 the way the real API does, so what these check is
// that dario relays that verdict faithfully instead of inventing its own.
header('a body dario cannot parse is relayed, not adjudicated');
{
  const cases = [
    ['non-JSON prose', 'this is not json, it is prose'],
    ['truncated JSON', '{"model":"claude-haiku-4-5-20251001","messa'],
    ['a JSON array', '[]'],
    ['a bare string', '"hello"'],
    ['JSON null', 'null'],
  ];
  for (const [label, body] of cases) {
    const before = upstreamCalls;
    const res = await send(body, {}, /* upstreamRejects */ true);
    check(`${label}: forwarded upstream rather than short-circuited`,
      upstreamCalls === before + 1, `${upstreamCalls - before} call(s)`);
    check(`${label}: upstream's status is relayed`, res.status === 400, res.status);
    check(`${label}: the client gets an Anthropic-shaped error`, isAnthropicError(res),
      (res.body ?? '').slice(0, 90));
    check(`${label}: dario did not substitute its own message`,
      parsed(res)?.error?.message === UPSTREAM_REJECT_MESSAGE,
      JSON.stringify(parsed(res)?.error?.message));
  }
}

header('a payload larger than MAX_BODY_BYTES');
{
  const before = upstreamCalls;
  const huge = JSON.stringify({
    model: 'claude-haiku-4-5-20251001', max_tokens: 16,
    messages: [{ role: 'user', content: 'x'.repeat(11 * 1024 * 1024) }],
  });
  const res = await send(huge);
  check('rejected with 413', res.status === 413, res.status);
  check('Anthropic-shaped error body', isAnthropicError(res), (res.body ?? '').slice(0, 120));
  check('never reached upstream', upstreamCalls === before);
}

header('the client hangs up mid-upload');
{
  const before = upstreamCalls;
  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001', max_tokens: 16,
    messages: [{ role: 'user', content: 'z'.repeat(4096) }],
  });
  await hangUpMidUpload(Buffer.byteLength(body), body.slice(0, 64));
  // A body that never arrived cannot be forwarded. Spending a pool token on it
  // would bill the user for a request they abandoned.
  check('never reached upstream', upstreamCalls === before, `${upstreamCalls - before} call(s)`);
  // Give the server a moment to unwind the aborted request before reading depth.
  await new Promise((r) => setTimeout(r, 300));
  const q = await queueDepth();
  check('the queue drained — no leaked slot', (q.active ?? 0) === 0 && (q.queued ?? 0) === 0,
    JSON.stringify(q));
}

header('the proxy is still healthy after every fault above');
{
  const res = await send(JSON.stringify({
    model: 'claude-haiku-4-5-20251001', max_tokens: 16,
    messages: [{ role: 'user', content: 'still here?' }],
  }));
  check('a normal request still gets 200', res.status === 200, res.status);
  const q = await queueDepth();
  check('queue back to idle', (q.active ?? 0) === 0 && (q.queued ?? 0) === 0, JSON.stringify(q));
}

await proxy.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
