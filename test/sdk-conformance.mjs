#!/usr/bin/env bun
/**
 * The official client SDK, pointed at a real dario.
 *
 * Everything else in this suite asserts dario's RESPONSE side by shape: event
 * names, dataKeys, header names. Shape assertions only ever catch the breakage
 * someone already thought of. `@anthropic-ai/sdk` is the server contract in
 * executable form — it accumulates the stream with its own state machine,
 * parses tool input out of `input_json_delta` fragments, picks an error class
 * off the status, and honours `retry-after`. If dario diverges from
 * api.anthropic.com anywhere along that path, the SDK is what notices.
 *
 * Hermetic: sandboxed HOME, no credentials, no network. `fetchImpl` stands in
 * for api.anthropic.com, so both ends of the proxy are under test at once —
 * the SDK is the client, `upstream` below is the server.
 *
 * Things the installed SDK (0.120.0) settled that the docs get wrong:
 *
 *   1. There is no `RequestTooLarge` class and no `OverloadedError` class.
 *      `APIError.generate` maps 400/401/403/404/409/422/429 and `>= 500`; 413
 *      falls through to the base `APIError`, and 529 lands on
 *      `InternalServerError` along with every other 5xx.
 *   2. `err.requestID` is read from the `request-id` RESPONSE HEADER, not from
 *      the `request_id` field in the error body. A body-only request_id is
 *      invisible to every SDK user.
 *   3. `retry-after` is parsed with `parseFloat` and multiplied by 1000, so a
 *      fractional second is honoured and this file stays fast.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'dario-sdk-conformance-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';

const { startProxy } = await import('../dist/proxy.js');
const Anthropic = (await import('@anthropic-ai/sdk')).default;
const {
  APIError, AuthenticationError, PermissionDeniedError, NotFoundError,
  BadRequestError, RateLimitError, InternalServerError,
} = await import('@anthropic-ai/sdk');

let pass = 0, fail = 0;
function check(label, cond, ...rest) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`, ...rest); }
}
function header(name) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}

function sse(events) {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}
const SSE_HEADERS = { 'content-type': 'text/event-stream', 'request-id': 'req_upstream_stream' };
const JSON_HEADERS = { 'content-type': 'application/json', 'request-id': 'req_upstream_json' };

// ----------------------------------------------------------------------
// The stand-in for api.anthropic.com. `upstream` is swapped per section.
let upstream = () => new Response('{}', { status: 200, headers: JSON_HEADERS });
let calls = [];

const fetchImpl = async (url, init) => {
  // dario hands fetch an ARRAY of [name, value] pairs — it replays CC's header
  // order, and an object literal would lose it. The body arrives as a
  // Uint8Array on the /v1/messages path. Normalising both here is the same
  // dance test/cc-wire-fidelity.mjs does, for the same reason.
  const h = {};
  const rh = init?.headers;
  if (Array.isArray(rh)) for (const [k, v] of rh) h[String(k).toLowerCase()] = String(v);
  else if (rh && typeof rh === 'object') for (const [k, v] of Object.entries(rh)) h[String(k).toLowerCase()] = String(v);
  let raw = init?.body;
  if (raw && typeof raw !== 'string') raw = new TextDecoder().decode(raw);
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
  const call = { url: String(url), method: init?.method ?? 'GET', headers: h, body };
  calls.push(call);
  return upstream(call);
};

const proxy = await startProxy({
  port: 0, host: '127.0.0.1',
  upstreamApiKey: 'sk-ant-test-not-a-real-key',
  noClaudeAuth: true, fetchImpl, noLiveCapture: true,
  // Behavioural smoothing off. Left on, dario holds each request ~450ms before
  // it reaches upstream, which costs this file ten seconds and — worse —
  // swamps the retry-after measurement below, where the number under test is
  // 50ms. Pacing has its own suite (test/pacing.mjs); nothing here is about it.
  pacingMinMs: 0, pacingJitterMs: 0,
});
const BASE = `http://127.0.0.1:${proxy.port}`;
for (let i = 0; i < 50; i++) {
  try { await fetch(`${BASE}/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

// maxRetries 0 by default so an assertion about a single upstream call means
// what it says; the retry section opts back in per request.
const client = new Anthropic({
  baseURL: BASE, apiKey: 'sk-ant-test-not-a-real-key', maxRetries: 0,
});

const MODEL = 'claude-haiku-4-5-20251001';
const ASK = [{ role: 'user', content: 'hello' }];

try {
  // ====================================================================
  header('a streaming response accumulates to a well-formed Message');
  {
    // Input split across four input_json_delta fragments, one of them cutting a
    // JSON string literal in half. The SDK buffers the fragments and parses
    // once at content_block_stop — if dario ever reordered, coalesced, or
    // dropped a delta, the parse is what breaks, and no dataKeys assertion in
    // this suite would have said a word.
    const TOOL_INPUT = { command: 'ls -la /tmp', description: 'list the temp dir' };
    const frags = ['{"command": "ls -l', 'a /tmp", "descrip', 'tion": "list the te', 'mp dir"}'];
    check('the fragments really are one tool input cut into pieces',
      JSON.stringify(JSON.parse(frags.join(''))) === JSON.stringify(TOOL_INPUT));

    upstream = () => new Response(sse([
      ['message_start', { type: 'message_start', message: {
        id: 'msg_conformance', type: 'message', role: 'assistant', model: MODEL,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 137, output_tokens: 1 },
      } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['ping', { type: 'ping' }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Listing ' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'the directory.' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_conformance', name: 'Bash', input: {} } }],
      ...frags.map((partial_json) => ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json } }]),
      ['content_block_stop', { type: 'content_block_stop', index: 1 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { input_tokens: 137, output_tokens: 42 } }],
      ['message_stop', { type: 'message_stop' }],
    ]), { status: 200, headers: SSE_HEADERS });

    calls = [];
    const stream = client.messages.stream({ model: MODEL, max_tokens: 1024, messages: ASK });
    const msg = await stream.finalMessage();

    check('exactly one upstream call', calls.length === 1);
    check('dario asked upstream to stream', calls[0]?.body?.stream === true);

    check('id survives the proxy', msg.id === 'msg_conformance');
    check('role is assistant', msg.role === 'assistant');
    check('stop_reason reaches the client', msg.stop_reason === 'tool_use');
    check('usage.input_tokens reaches the client', msg.usage.input_tokens === 137);
    check('usage.output_tokens is the message_delta value, not the message_start one',
      msg.usage.output_tokens === 42);

    check('two content blocks, in the order upstream sent them',
      msg.content.length === 2 && msg.content[0].type === 'text' && msg.content[1].type === 'tool_use');
    check('text deltas concatenated in order',
      msg.content[0].text === 'Listing the directory.');
    check('the accumulated text helper agrees',
      (await stream.finalText()) === 'Listing the directory.');

    const tool = msg.content[1];
    check('tool_use keeps its id and name', tool.id === 'toolu_conformance' && tool.name === 'Bash');
    check('tool input parsed whole from four input_json_delta fragments',
      JSON.stringify(tool.input) === JSON.stringify(TOOL_INPUT));

    check('the SDK saw upstream\'s request-id header on the stream',
      stream.request_id === 'req_upstream_stream');
  }

  // ====================================================================
  header('a stream carrying only text still lands, and the raw events survive');
  {
    upstream = () => new Response(sse([
      ['message_start', { type: 'message_start', message: {
        id: 'msg_text', type: 'message', role: 'assistant', model: MODEL,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 9, output_tokens: 1 },
      } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'PONG' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }],
      ['message_stop', { type: 'message_stop' }],
    ]), { status: 200, headers: SSE_HEADERS });

    calls = [];
    const seen = [];
    const stream = client.messages.stream({ model: MODEL, max_tokens: 64, messages: ASK });
    for await (const ev of stream) seen.push(ev.type);
    const msg = await stream.finalMessage();

    check('every raw event type reached the SDK, in order',
      seen.join(' ') === 'message_start content_block_start content_block_delta content_block_stop message_delta message_stop');
    check('stop_reason end_turn', msg.stop_reason === 'end_turn');
    check('text block accumulated', msg.content[0]?.text === 'PONG');
    // message_delta omitted input_tokens here, as the real API does when the
    // count has not changed. The snapshot must keep the message_start value
    // rather than zeroing it.
    check('input_tokens kept from message_start when message_delta omits it',
      msg.usage.input_tokens === 9);
  }

  // ====================================================================
  header('a non-streaming request round-trips');
  {
    upstream = () => new Response(JSON.stringify({
      id: 'msg_nonstream', type: 'message', role: 'assistant', model: MODEL,
      content: [{ type: 'text', text: 'no stream here' }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 11, output_tokens: 4 },
    }), { status: 200, headers: JSON_HEADERS });

    calls = [];
    const msg = await client.messages.create({ model: MODEL, max_tokens: 64, messages: ASK });
    check('one upstream call', calls.length === 1);
    check('id, content and stop_reason all survive',
      msg.id === 'msg_nonstream' && msg.content[0].text === 'no stream here' && msg.stop_reason === 'end_turn');
    check('usage survives', msg.usage.input_tokens === 11 && msg.usage.output_tokens === 4);
    check('the SDK parsed it as a Message, not as a blob', msg.type === 'message');
  }

  // ====================================================================
  header('countTokens');
  {
    upstream = () => new Response(JSON.stringify({ input_tokens: 2095 }), { status: 200, headers: JSON_HEADERS });
    calls = [];
    const counted = await client.messages.countTokens({ model: MODEL, messages: ASK });
    check('countTokens returns input_tokens', counted.input_tokens === 2095);
    check('it went to the count_tokens path, not /v1/messages',
      calls[0]?.url.endsWith('/v1/messages/count_tokens'));
    check('the prompt being counted is forwarded unedited',
      JSON.stringify(calls[0]?.body?.messages) === JSON.stringify(ASK));
  }

  // ====================================================================
  header('upstream error status → SDK error class');
  {
    // The mapping is APIError.generate's, read out of the installed SDK. 413
    // and 529 are the two the published tables get wrong: neither
    // RequestTooLarge nor OverloadedError exists as a class.
    const TYPE = {
      400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error',
      404: 'not_found_error', 413: 'request_too_large', 429: 'rate_limit_error',
      500: 'api_error', 502: 'api_error', 529: 'overloaded_error',
    };
    const CLASS = {
      400: BadRequestError, 401: AuthenticationError, 403: PermissionDeniedError,
      404: NotFoundError, 413: APIError, 429: RateLimitError,
      500: InternalServerError, 502: InternalServerError, 529: InternalServerError,
    };
    // Only 413 is deliberately the base class. Assert the others are NOT, so a
    // future SDK that grows RequestTooLarge does not silently pass here.
    const SUBCLASSES = [BadRequestError, AuthenticationError, PermissionDeniedError,
      NotFoundError, RateLimitError, InternalServerError];

    for (const status of [400, 401, 403, 404, 413, 429, 500, 502, 529]) {
      const message = `upstream said ${status}`;
      upstream = () => new Response(JSON.stringify({
        type: 'error', error: { type: TYPE[status], message }, request_id: 'req_upstream_err',
      }), { status, headers: { ...JSON_HEADERS, 'request-id': 'req_upstream_err' } });

      calls = [];
      let err = null;
      try {
        await client.messages.create({ model: MODEL, max_tokens: 64, messages: ASK });
      } catch (e) { err = e; }

      check(`${status} → ${CLASS[status].name}`, err instanceof CLASS[status]);
      check(`  …status preserved through dario`, err?.status === status);
      check(`  …error.type is ${TYPE[status]}`, err?.type === TYPE[status]);
      // APIError.makeMessage reads `body.message`, which the Anthropic envelope
      // does not have — the human string lives at `body.error.message`. So the
      // SDK stringifies the whole envelope and prefixes the status. Ugly, but
      // it is what a client sees against api.anthropic.com too, and the string
      // that matters is still in there. What this catches is dario re-wrapping
      // the body into something whose message stringifies to "[object Object]",
      // which is what an operator would paste into a bug report.
      check(`  …the human string survives into err.message`,
        String(err?.message).startsWith(`${status} `)
        && String(err?.message).includes(message)
        && !String(err?.message).includes('[object Object]'));
      check(`  …request-id header forwarded, so err.requestID is populated`,
        err?.requestID === 'req_upstream_err');
      if (status === 413) {
        check('  …413 is the base APIError — the SDK has no RequestTooLarge class',
          SUBCLASSES.every((C) => !(err instanceof C)));
      }
    }
  }

  // ====================================================================
  header('errors dario answers itself, as the SDK sees them');
  {
    // These never reach upstream: dario rejects them at the router. A client
    // library must still be able to tell what happened.
    upstream = () => { throw new Error('must not reach upstream'); };

    // An unknown path answers 404, matching what the real API does with one:
    // GET /v1/definitely-not-a-real-path returns 404 not_found_error, not the
    // 403 dario used to serve. A 403 tells a client its credential is wrong
    // and sends it off to re-authenticate over a typo in the path.
    for (const [what, call, Cls, type] of [
      ['an unsupported path → 404', () => client.get('/v1/nope'), NotFoundError, 'not_found_error'],
      ['the right path with the wrong method → 405', () => client.get('/v1/messages'), APIError, 'invalid_request_error'],
    ]) {
      let err = null;
      try { await call(); } catch (e) { err = e; }
      check(`${what} raises ${Cls.name}`, err instanceof Cls);
      check(`  …error.type is ${type}`, err?.type === type);
      check(`  …message is a human string`,
        typeof err?.message === 'string' && err.message.length > 4 && !err.message.includes('[object Object]'));
      check(`  …the body carries dario's request_id`,
        /^req_dario_[0-9a-f]{32}$/.test(err?.error?.request_id ?? ''));

      // The SDK reads err.requestID off the `request-id` RESPONSE HEADER
      // (core/error.js: `this.requestID = headers?.get('request-id')`) and
      // never looks at the body. dario used to set request_id in the body
      // alone, which left every SDK user with `undefined` where the id should
      // be — nothing in the body could help, because the SDK does not read it.
      check(`  …and err.requestID is populated from the request-id header`,
        /^req_dario_[0-9a-f]{32}$/.test(err?.requestID ?? ''));
      // Header and body must agree, or the id a client quotes and the id an
      // operator greps the log for are two different strings.
      check(`  …header and body quote the same id`,
        err?.requestID === err?.error?.request_id);
    }

    // The error bodies used to be built once at startProxy time, so every 404
    // a process served quoted one frozen request_id. Two failures sharing an
    // id are indistinguishable in a bug report.
    let a = null, b = null;
    try { await client.get('/v1/nope'); } catch (e) { a = e; }
    try { await client.get('/v1/other'); } catch (e) { b = e; }
    check('two separate 404s carry different request_ids',
      a?.error?.request_id !== b?.error?.request_id);
    check('  …and their request-id headers differ too', a?.requestID !== b?.requestID);
  }

  // ====================================================================
  header('retry-after on a 429 drives the SDK\'s own retry');
  {
    // The SDK parses retry-after with parseFloat and multiplies by 1000, so
    // 0.05 is 50ms and this stays fast. If dario ever stopped forwarding
    // retry-after, the SDK would fall back to its 0.5s exponential backoff and
    // ignore the pacing upstream asked for — invisible to a header-name
    // assertion, which only checks the allowlist, not the wire.
    let attempt = 0;
    upstream = () => {
      attempt++;
      if (attempt === 1) {
        return new Response(JSON.stringify({
          type: 'error', error: { type: 'rate_limit_error', message: 'slow down' },
        }), { status: 429, headers: { ...JSON_HEADERS, 'retry-after': '0.05' } });
      }
      return new Response(JSON.stringify({
        id: 'msg_after_retry', type: 'message', role: 'assistant', model: MODEL,
        content: [{ type: 'text', text: 'retried' }], stop_reason: 'end_turn',
        stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 },
      }), { status: 200, headers: JSON_HEADERS });
    };

    // Timestamped at the client's own socket, not around the whole call: what
    // is under test is the gap the SDK sleeps BETWEEN attempts, and wall-clock
    // total would fold dario's request latency into the number.
    const marks = [];
    const timed = new Anthropic({
      baseURL: BASE, apiKey: 'sk-ant-test-not-a-real-key', maxRetries: 0,
      fetch: async (u, i) => { marks.push(['send', Date.now()]); const r = await fetch(u, i); marks.push(['recv', Date.now()]); return r; },
    });

    calls = [];
    const msg = await timed.messages.create(
      { model: MODEL, max_tokens: 64, messages: ASK }, { maxRetries: 2 },
    );

    check('the retry succeeded', msg.id === 'msg_after_retry');
    check(`upstream saw exactly two attempts (saw ${attempt})`, attempt === 2);
    check('and the client made both of them through dario', calls.length === 2);

    const firstRecv = marks.find(([k]) => k === 'recv')?.[1];
    const secondSend = marks.filter(([k]) => k === 'send')[1]?.[1];
    const waited = secondSend - firstRecv;
    check('the client did retry, so there are two sends to measure between',
      Number.isFinite(waited));
    check(`the SDK slept rather than firing straight back (${waited}ms)`, waited >= 40);
    // The SDK's own floor is 500ms of exponential backoff. Landing under that
    // is the proof that retry-after reached it — dario dropping the header
    // would still produce a passing retry, just a slower one, and every
    // header-name assertion in this suite would stay green.
    check('and it slept the 50ms upstream asked for, not its own 500ms backoff',
      waited < 300);

    // A 429 with no retry-after must still be retried — the SDK's shouldRetry
    // returns true on 429 regardless. This pins that dario passing the status
    // through unchanged is enough to keep the client's retry policy working.
    attempt = 0;
    upstream = () => {
      attempt++;
      if (attempt === 1) {
        return new Response(JSON.stringify({
          type: 'error', error: { type: 'overloaded_error', message: 'overloaded' },
        }), { status: 529, headers: JSON_HEADERS });
      }
      return new Response(JSON.stringify({
        id: 'msg_after_529', type: 'message', role: 'assistant', model: MODEL,
        content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
        stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 },
      }), { status: 200, headers: JSON_HEADERS });
    };
    const after529 = await client.messages.create(
      { model: MODEL, max_tokens: 64, messages: ASK }, { maxRetries: 2 },
    );
    check('a 529 is retryable too, and dario keeps the status intact',
      after529.id === 'msg_after_529' && attempt === 2);

    // 400 must NOT be retried. If dario ever rewrote a client mistake into a
    // 5xx, the SDK would hammer upstream two extra times for nothing.
    attempt = 0;
    upstream = () => {
      attempt++;
      return new Response(JSON.stringify({
        type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: Field required' },
      }), { status: 400, headers: JSON_HEADERS });
    };
    let bad = null;
    try {
      await client.messages.create({ model: MODEL, max_tokens: 64, messages: ASK }, { maxRetries: 2 });
    } catch (e) { bad = e; }
    check('a 400 is not retried — dario did not launder it into a 5xx',
      bad instanceof BadRequestError && attempt === 1);
  }
} finally {
  await proxy.close?.();
  await rm(home, { recursive: true, force: true });
}

console.log(`\n${'='.repeat(70)}\n  ${pass} pass, ${fail} fail\n${'='.repeat(70)}`);
process.exit(fail === 0 ? 0 : 1);
