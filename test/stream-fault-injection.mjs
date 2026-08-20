#!/usr/bin/env bun
/**
 * Mid-stream fault injection.
 *
 * Every streaming suite in this repo asserts what happens when upstream
 * behaves. streaming-edge-cases.mjs shreds a WELL-FORMED stream through the
 * reverse-mapper; stream-drain.mjs covers decideOnClientClose as a pure
 * function; queue-slot-leak.mjs covers a client that stops reading. Nothing
 * covered the direction production actually fails in: upstream answers 200,
 * starts streaming, and then breaks.
 *
 * The faults here are documented API behaviour, not inventions:
 *
 *   - `event: error` mid-stream is in the streaming docs verbatim
 *     (`{"type":"error","error":{"type":"overloaded_error",...}}`), normally a
 *     529 in the non-streaming path. It is common enough that LiteLLM shipped
 *     a whole mid-stream fallback path for it (BerriAI/litellm#24004: 510
 *     occurrences in one 80-minute window).
 *   - A stream that just stops before `message_stop` is
 *     anthropics/anthropic-sdk-typescript#842, reported against tool_use with
 *     large JSON payloads. The SDK's accumulator throws "Stream ended without
 *     message_stop"; a raw consumer gets nothing at all.
 *   - Truncated `input_json_delta` is the normal shape when generation hits
 *     max_tokens inside a tool block. The docs say tool_use blocks "cannot be
 *     partially recovered", so the client has to SEE that it was cut.
 *   - `ping` is a liveness signal upstream sends every ~15-30s. Proxies drop
 *     it at their peril (anthropics/anthropic-sdk-typescript#998).
 *
 * Hermetic: scripted upstream via ProxyOptions.fetchImpl, sandboxed HOME, no
 * credentials, no network. The read timeout is driven by the injectable
 * upstreamTimeoutMs, not by a real 600s wait.
 *
 * Assertions that document behaviour dario does NOT have yet are gated behind
 * DARIO_STREAM_STRICT=1 so the shared suite stays green. Run
 * `DARIO_STREAM_STRICT=1 bun test/stream-fault-injection.mjs` to see them.
 */

import { rmSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0, gatedOff = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? ' :: ' + detail : ''}`); }
}
/**
 * An assertion for behaviour dario should have and does not. Off by default:
 * the shared runner scores this file, and a known gap must not fail it. Each
 * call site says what the correct behaviour is and what the gap costs.
 */
const STRICT = process.env.DARIO_STREAM_STRICT === '1';
function strict(label, cond, detail) {
  if (!STRICT) { gatedOff++; console.log(`  SKIP ${label} (DARIO_STREAM_STRICT=1 to enforce)`); return; }
  check(label, cond, detail);
}
function header(name) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const home = await mkdtemp(join(tmpdir(), 'dario-stream-fault-'));
// On 'exit', not after the last assertion: a failing check exits(1) below,
// which is exactly when the stranded dir is most likely.
process.on('exit', () => rmSync(home, { recursive: true, force: true }));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';

const { startProxy } = await import('../dist/proxy.js');
const { createStreamingReverseMapper } = await import('../dist/cc-template.js');

const enc = new TextEncoder();
const dec = new TextDecoder();
const EV = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// ======================================================================
header('what a healthy stream looks like — the recorded baseline');
// ======================================================================
// The reference the truncation assertions are measured against, and the raw
// bytes the fault sections cut up. This is the real event sequence
// api.anthropic.com sent CC 2.1.236 on its web-search turn, not a belief about
// it: a server_tool_use block, a zero-delta web_search_tool_result, citation
// deltas, seven content blocks. Richer than the main-loop capture, and the
// block types are exactly the ones a naive proxy mishandles. If upstream's
// terminal event ever stops being message_stop, the faults below are testing
// the wrong shape and this fails first.
const DIR = join(import.meta.dirname, 'fixtures', 'cc-wire-2.1.236');
const WEB_SEARCH = JSON.parse(readFileSync(join(DIR, 'web-search-server-tool.full.json'), 'utf8'));
const RECORDED = WEB_SEARCH.response.body;
/** The recorded stream as SSE event groups, so a fault can cut it on a real boundary. */
const RECORDED_GROUPS = RECORDED.split('\n\n').filter(Boolean);
const groupEvent = (g) => g.split('\n').find((l) => l.startsWith('event:'))?.slice(6).trim();
const groupData = (g) => {
  const d = g.split('\n').find((l) => l.startsWith('data:'))?.slice(5).trim();
  if (!d || d === '[DONE]') return null;
  try { return JSON.parse(d); } catch { return null; }
};
/** First group index whose content_block_start opens a block of this type. */
const startIndexOf = (blockType) => RECORDED_GROUPS.findIndex((g) => {
  const e = groupData(g);
  return e?.type === 'content_block_start' && e.content_block?.type === blockType;
});
/** The recorded stream cut after `n` complete event groups — a real socket death boundary. */
const recordedPrefix = (n) => RECORDED_GROUPS.slice(0, n).join('\n\n') + '\n\n';
{
  const events = RECORDED_GROUPS.map(groupEvent);
  check('a healthy stream opens with message_start', events[0] === 'message_start');
  check('a healthy stream closes with message_stop', events.at(-1) === 'message_stop');
  check('message_delta carries the terminal usage, and precedes message_stop',
    events.indexOf('message_delta') === events.length - 2);
  check('every block is bracketed by content_block_start .. content_block_stop',
    events.filter((e) => e === 'content_block_start').length
      === events.filter((e) => e === 'content_block_stop').length);
  check('upstream interleaves ping as a liveness signal', events.includes('ping'));
  check('the recording contains no error event (this is the healthy case)',
    !events.includes('error'));

  // The block types this fixture adds over the main-loop one. Each is a shape
  // the fault sections below cut into, so pin that they are actually present.
  check('it carries a server_tool_use block (web_search) with input_json_delta',
    startIndexOf('server_tool_use') >= 0
      && groupData(RECORDED_GROUPS[startIndexOf('server_tool_use')]).content_block.name === 'web_search');
  check('the server tool\'s first input_json_delta is empty — a proxy that treats "" as absent loses the block',
    RECORDED_GROUPS.some((g) => groupData(g)?.delta?.type === 'input_json_delta'
      && groupData(g).delta.partial_json === ''));
  check('web_search_tool_result arrives as a start immediately followed by a stop, zero deltas — the whole result rides in the start event',
    groupEvent(RECORDED_GROUPS[startIndexOf('web_search_tool_result') + 1]) === 'content_block_stop');
  check('it carries citations_delta, a delta type the tool reverse-mapper has no case for',
    RECORDED_GROUPS.some((g) => groupData(g)?.delta?.type === 'citations_delta'));
}

// ----------------------------------------------------------------------
// Scripted fault-injecting upstream. `mode` selects the fault; the proxy is
// started once and each section flips the mode before its request.
// ----------------------------------------------------------------------
let mode = 'healthy';

const PREFIX = [
  EV('message_start', { type: 'message_start', message: { id: 'msg_fault', type: 'message', role: 'assistant', model: 'claude-opus-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 1 } } }),
  EV('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  EV('ping', { type: 'ping' }),
  EV('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }),
];
const TOOL_START = EV('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_fault', name: 'Bash', input: {} } });
const TRUNCATED_ARGS = '{"command":"grep -rn \\"needle\\" /very/long/pa';
const COMPLETE_ARGS = '{"command":"ls -la /tmp"}';

const SSE_HEADERS = { 'content-type': 'text/event-stream', 'request-id': 'req_fault_fixture' };

const faultingFetch = async (url, init) => {
  // Pool-mode startup probes the plan endpoint; answer it so no real network
  // call is attempted and the account lands in the pool as usable.
  if (String(url).includes('/api/oauth/profile')) {
    return new Response(JSON.stringify({ account: { has_claude_max: true } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }

  // Pre-header faults: no Response is ever produced, so dario still owns the
  // status line and answers with its own error rather than a broken stream.
  if (mode === 'connect-refused') throw new Error('connect ECONNREFUSED 127.0.0.1:443');
  if (mode === 'never-answers') {
    // Headers never arrive. Only the upstream timeout can end this.
    return await new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  }

  // Replay of the real recorded web-search stream, optionally cut after N
  // complete event groups. Cutting on a group boundary is the honest shape:
  // a socket dies between frames far more often than mid-frame, and it lets
  // the assertions compare against an exact expected prefix.
  if (typeof mode === 'number' || mode === 'recorded') {
    const payload = mode === 'recorded' ? RECORDED : recordedPrefix(mode);
    return new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(enc.encode(payload));
        if (mode === 'recorded') { controller.close(); return; }
        await sleep(20);
        controller.error(new Error('ECONNRESET simulated'));
      },
    }), { status: 200, headers: SSE_HEADERS });
  }

  if (mode === '429-retry-after') {
    // A 429 on the request that OPENS the stream: no SSE was ever started, so
    // this is an ordinary HTTP error the client must be able to act on.
    // `message: 'Error'` is what Anthropic actually sends — enrich429 rewrites
    // it from the rate-limit headers.
    return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Error' } }), {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': '37',
        'x-should-retry': 'true',
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
        'anthropic-ratelimit-unified-5h-utilization': '1.0',
        'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 90),
      },
    });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const push = (s) => controller.enqueue(enc.encode(s));
      switch (mode) {
        case 'die-after-4':
          // Four good events, then the socket dies. controller.error() is what
          // a real fetch body does on ECONNRESET.
          for (const e of PREFIX) push(e);
          await sleep(20);
          controller.error(new Error('ECONNRESET simulated'));
          break;
        case 'error-event':
          for (const e of PREFIX) push(e);
          push('event: error\ndata: {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}\n\n');
          controller.close();
          break;
        case 'truncated-tool-json':
          // Generation hit max_tokens inside the tool block: the accumulated
          // JSON never closes, but the framing is complete.
          push(PREFIX[0]);
          push(TOOL_START);
          push(EV('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: TRUNCATED_ARGS } }));
          push(EV('content_block_stop', { type: 'content_block_stop', index: 0 }));
          push(EV('message_delta', { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: 42 } }));
          push(EV('message_stop', { type: 'message_stop' }));
          controller.close();
          break;
        case 'no-content-block-stop':
          // Complete tool arguments, but the block is never closed before the
          // message is. The bytes exist; the framing lost them.
          push(PREFIX[0]);
          push(TOOL_START);
          push(EV('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: COMPLETE_ARGS } }));
          push(EV('message_stop', { type: 'message_stop' }));
          controller.close();
          break;
        case 'stall':
          // One event, then silence forever. Only the read timeout can end it.
          push(PREFIX[0]);
          init?.signal?.addEventListener('abort', () => {
            try { controller.error(new Error('upstream aborted')); } catch { /* already closed */ }
          });
          break;
        default:
          for (const e of PREFIX) push(e);
          push(EV('content_block_stop', { type: 'content_block_stop', index: 0 }));
          push(EV('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }));
          push(EV('message_stop', { type: 'message_stop' }));
          controller.close();
      }
    },
  });
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
};

// Port 0: the kernel picks one that is provably free and startProxy reports it
// back, so a parallel suite or a stale bind cannot silently steal the run.
const UPSTREAM_TIMEOUT_MS = 1_200;
const proxy = await startProxy({
  port: 0, host: '127.0.0.1',
  upstreamApiKey: 'sk-ant-test-not-a-real-key',
  noClaudeAuth: true,
  fetchImpl: faultingFetch,
  noLiveCapture: true,       // else startup spawns a real `claude` capture
  maxConcurrent: 2,          // small enough that one leaked slot is visible
  upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
  queueTimeoutMs: 2_000,
});
const BASE = `http://127.0.0.1:${proxy.port}`;
for (let i = 0; i < 50; i++) {
  try { await fetch(`${BASE}/health`); break; } catch { await sleep(100); }
}

const EXEC_TOOL = {
  name: 'exec',
  description: 'run a shell command',
  input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
};
/** POST a streaming /v1/messages and return status, headers and the full body. */
async function stream(body, path = '/v1/messages') {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 128, stream: true, ...body }),
  });
  let text = '', transportError = null;
  try { text = await res.text(); } catch (err) { transportError = String(err); }
  return { status: res.status, headers: res.headers, text, transportError };
}
const events = (sse) => sse.split('\n\n').filter(Boolean)
  .map((g) => g.split('\n').find((l) => l.startsWith('event:'))?.slice(6).trim())
  .filter(Boolean);
/**
 * Split a delivered stream into the bytes upstream actually sent and the
 * terminal `event: error` dario appends when the stream ends abnormally.
 * Every truncation assertion below is the same two-part claim: upstream's
 * prefix survives byte for byte, and exactly one terminal frame follows it.
 */
function splitTerminalError(sse) {
  const groups = sse.split('\n\n').filter(Boolean);
  const terminal = groupEvent(groups.at(-1)) === 'error';
  return {
    terminal,
    errorFrames: groups.filter((g) => groupEvent(g) === 'error').length,
    error: terminal ? groupData(groups.at(-1)) : null,
    upstreamBytes: terminal
      ? (groups.length > 1 ? groups.slice(0, -1).join('\n\n') + '\n\n' : '')
      : sse,
  };
}
/** The terminal frame is well-formed and type-switchable. Shared by every fault. */
function checkTerminalError(label, sse, wantType) {
  const t = splitTerminalError(sse);
  check(`${label}: ends with a terminal \`event: error\` instead of a bare close`,
    t.terminal, JSON.stringify(sse.slice(-160)));
  check(`${label}: exactly one terminal frame, not one per failed read`,
    t.errorFrames === 1, String(t.errorFrames));
  check(`${label}: the frame carries an envelope a client can type-switch on`,
    t.error?.type === 'error' && t.error.error?.type === wantType
      && typeof t.error.error?.message === 'string' && t.error.error.message.length > 0,
    JSON.stringify(t.error));
  return t;
}
const queueSnapshot = async () => (await (await fetch(`${BASE}/analytics`)).json()).queue;
const debugEntries = async () => (await (await fetch(`${BASE}/debug/requests`)).json()).entries;

const baselineSlots = await queueSnapshot();
check('the proxy starts with no slots held', baselineSlots.active === 0 && baselineSlots.queued === 0,
  JSON.stringify(baselineSlots));

// ======================================================================
header('fault 1 — upstream socket dies after 4 events');
// ======================================================================
// The question: does a client learn the response was cut off? The answer at
// every layer is no. dario sends the four events it received and then calls
// res.end(), which writes a well-formed terminating chunk on a keep-alive
// connection. There is no transport error, no HTTP error, and no SSE error —
// a truncated response is byte-indistinguishable from a complete one until
// the client's own accumulator notices message_stop never came
// (anthropics/anthropic-sdk-typescript#842). The upstream failure that WOULD
// have surfaced as a transport error to a direct caller is laundered into a
// clean success by the proxy. src/proxy.ts:4787-4799 (`catch` → unconditional `res.end()`).
let dieAfter4;
{
  mode = 'die-after-4';
  dieAfter4 = await stream({ messages: [{ role: 'user', content: 'hi' }] });
  const seen = events(dieAfter4.text);

  check('status is 200 — headers were already sent, so it cannot be anything else',
    dieAfter4.status === 200, String(dieAfter4.status));
  check('the four events upstream managed to send all reach the client, in order',
    seen.slice(0, 4).join(' ') === 'message_start content_block_start ping content_block_delta', seen.join(' '));
  check('ping survives the proxy — it is upstream\'s liveness signal, and an intermediary that swallows it turns a slow stream into an idle one',
    seen.includes('ping'));
  check('the client still sees no message_stop — dario reports the truncation, it does not paper over it',
    !seen.includes('message_stop'));
  check('and no transport-level error either — fetch() resolves cleanly, which is exactly why the SSE frame has to carry the signal',
    dieAfter4.transportError === null, dieAfter4.transportError ?? '');

  // Everything upstream already sent stays; dario appends the terminal event
  // the API itself uses for this condition, so an SDK raises a typed error
  // instead of "stream ended unexpectedly" and a raw consumer gets any signal
  // at all. Without it the response is byte-indistinguishable from a complete
  // one at HTTP, SSE and transport level all three.
  checkTerminalError('socket death', dieAfter4.text, 'api_error');

  // Same fault down the OpenAI-shape route, where the contract is stricter:
  // `data: [DONE]` is the sentinel every OpenAI SDK waits for, so its absence
  // is the only thing distinguishing a cut stream from a finished one. The
  // translator already knows how to emit an error chunk + [DONE] — it does
  // exactly that on the SSE-line-overflow path in src/proxy.ts:4748 — but the
  // upstream-died path never reaches it.
  const openai = await stream({ messages: [{ role: 'user', content: 'hi' }] }, '/v1/chat/completions');
  check('the OpenAI route also 200s and forwards what it got',
    openai.status === 200 && openai.text.includes('"chat.completion.chunk"'),
    JSON.stringify(openai.text.slice(0, 120)));
  check('with no finish_reason:stop — the turn never finished, and claiming it did would be the same lie in OpenAI shape',
    !openai.text.includes('"finish_reason":"stop"'));
  check('the OpenAI route terminates a broken stream with the [DONE] sentinel, which is what ends the SDK\'s iterator',
    openai.text.trimEnd().endsWith('data: [DONE]'), JSON.stringify(openai.text.slice(-160)));
  check('and an OpenAI-shaped error chunk precedes it, so the reason is not lost',
    (() => {
      const chunk = openai.text.split('\n\n').filter(Boolean).at(-2);
      try { return typeof JSON.parse(chunk.slice(6)).error?.message === 'string'; } catch { return false; }
    })(), JSON.stringify(openai.text.slice(-260)));
  check('the OpenAI route does NOT get the Anthropic frame — each client shape gets its own terminator',
    !openai.text.includes('event: error'));
}

// ======================================================================
header('fault 2 — upstream emits `event: error` on an already-200 stream');
// ======================================================================
// The documented mid-stream error. dario must forward it byte-for-byte: it is
// the client's only signal, and rewriting the envelope breaks the type switch
// downstream consumers do on `error.type` (overloaded_error → retryable,
// everything else → not).
{
  mode = 'error-event';
  const r = await stream({ messages: [{ role: 'user', content: 'hi' }] });
  const group = r.text.split('\n\n').find((g) => g.startsWith('event: error'));
  check('the error event reaches the client', group !== undefined, JSON.stringify(r.text.slice(-200)));
  check('forwarded verbatim, whitespace included — dario neither reframes nor re-serialises it',
    group === 'event: error\ndata: {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}',
    JSON.stringify(group));
  check('it arrives after the events that preceded it, not reordered',
    events(r.text).join(' ') === 'message_start content_block_start ping content_block_delta error');
  check('dario does not invent a message_stop upstream never sent',
    !r.text.includes('message_stop'));
}

// ======================================================================
header('fault 3 — truncated input_json_delta, then a normal close');
// ======================================================================
// max_tokens inside a tool block. The accumulated JSON never closes. The
// streaming reverse-mapper buffers input_json_delta to translate it at
// content_block_stop, so a payload it cannot parse is the one input that could
// make it throw and take the whole stream down mid-flight.
{
  mode = 'truncated-tool-json';
  const r = await stream({ messages: [{ role: 'user', content: 'run it' }], tools: [EXEC_TOOL] });
  const seen = events(r.text);

  check('the mapper does not throw — the stream still terminates with message_stop',
    seen.at(-1) === 'message_stop', seen.join(' '));
  check('framing survives: every event group parses as JSON',
    r.text.split('\n\n').filter(Boolean).every((g) => {
      const d = g.split('\n').find((l) => l.startsWith('data:'))?.slice(5).trim();
      if (!d || d === '[DONE]') return true;
      try { JSON.parse(d); return true; } catch { return false; }
    }));
  check('the tool name is still reverse-mapped to the client\'s own (Bash → exec)',
    r.text.includes('"name":"exec"') && !r.text.includes('"name":"Bash"'));
  check('the unparseable partial is passed through raw rather than swallowed — the client needs to see WHAT it got, since a tool_use block cannot be partially recovered',
    r.text.includes(JSON.stringify(TRUNCATED_ARGS).slice(1, -1)),
    JSON.stringify(r.text.slice(0, 400)));
  check('stop_reason max_tokens reaches the client so it can tell truncation from a short answer',
    r.text.includes('"stop_reason":"max_tokens"'));
}

// ======================================================================
header('fault 4 — content_block_stop missing before message_stop');
// ======================================================================
// BUG. The reverse-mapper SWALLOWS every input_json_delta for a buffered tool
// block, planning to emit one synthetic combined delta at content_block_stop.
// If that stop never arrives, end() flushes only the raw group buffer — the
// `buffered` map is dropped on the floor (createStreamingReverseMapper in
// src/cc-template.ts, the end() at the bottom). The client is left holding a
// content_block_start with `input:{}` and a message_stop: a well-formed,
// terminal, and completely wrong tool call. It does not look like an error, so
// nothing downstream retries — it looks like the model called exec with no
// arguments. The 2MB-cap path a few lines up already knows the right move:
// flush the accumulated partial as a passthrough delta.
{
  mode = 'no-content-block-stop';
  const r = await stream({ messages: [{ role: 'user', content: 'run it' }], tools: [EXEC_TOOL] });
  const seen = events(r.text);

  check('the stream stays well-formed and terminates', seen.at(-1) === 'message_stop', seen.join(' '));
  check('the tool block still opens with the client\'s tool name', r.text.includes('"name":"exec"'));
  check('the buffered tool arguments reach the client even though content_block_stop never arrived',
    r.text.includes('ls -la /tmp'), JSON.stringify(r.text));
  check('they arrive BEFORE message_stop, not stranded after the message ended',
    r.text.indexOf('ls -la /tmp') < r.text.indexOf('"type":"message_stop"'));
  check('and are released raw, not translated — nothing licensed treating the JSON as complete',
    r.text.includes(`"partial_json":${JSON.stringify(COMPLETE_ARGS)}`), JSON.stringify(r.text));
  check('dario does not invent the content_block_stop upstream withheld',
    !r.text.includes('"type":"content_block_stop"'));

  // Same fault against the mapper directly, so the assertion above has an
  // unambiguous owner. No proxy, no tool-map derivation — just feed and end.
  const toolMap = new Map([['exec', {
    ccTool: 'Bash',
    translateBack: (a) => ({ command: a.command ?? '' }),
  }]]);
  const mapper = createStreamingReverseMapper(toolMap);
  let out = dec.decode(mapper.feed(enc.encode(TOOL_START)), { stream: true });
  out += dec.decode(mapper.feed(enc.encode(EV('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: COMPLETE_ARGS } }))), { stream: true });
  check('mapper-direct: the delta is still swallowed on the way in — buffering is intact, only the release changed',
    !out.includes('ls -la /tmp'));
  out += dec.decode(mapper.feed(enc.encode(EV('message_stop', { type: 'message_stop' }))), { stream: true });
  out += dec.decode(mapper.end());
  check('mapper-direct: message_stop releases the still-buffered block instead of discarding it',
    out.includes('ls -la /tmp'), JSON.stringify(out));
  check('mapper-direct: released before the message_stop it was holding up',
    out.indexOf('ls -la /tmp') < out.indexOf('"type":"message_stop"'), JSON.stringify(out));

  // A stream that dies with no terminal event at all never reaches the
  // message_stop branch, so end() is the only place left to release it.
  const dead = createStreamingReverseMapper(toolMap);
  let deadOut = dec.decode(dead.feed(enc.encode(TOOL_START)), { stream: true });
  deadOut += dec.decode(dead.feed(enc.encode(EV('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: COMPLETE_ARGS } }))), { stream: true });
  deadOut += dec.decode(dead.end());
  check('mapper-direct: end() releases a block held by a stream that just stopped',
    deadOut.includes('ls -la /tmp'), JSON.stringify(deadOut));

  // The fix has to be invisible on a stream that closes its blocks properly,
  // or it would corrupt every healthy tool call to repair a broken one.
  const healthy = createStreamingReverseMapper(toolMap);
  let ok = dec.decode(healthy.feed(enc.encode(TOOL_START)), { stream: true });
  ok += dec.decode(healthy.feed(enc.encode(EV('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: COMPLETE_ARGS } }))), { stream: true });
  ok += dec.decode(healthy.feed(enc.encode(EV('content_block_stop', { type: 'content_block_stop', index: 0 }))), { stream: true });
  ok += dec.decode(healthy.feed(enc.encode(EV('message_stop', { type: 'message_stop' }))), { stream: true });
  ok += dec.decode(healthy.end());
  check('mapper-direct: a properly-closed block still emits exactly one translated delta — the flush adds nothing',
    ok.split('"type":"input_json_delta"').length - 1 === 1, JSON.stringify(ok));
  check('mapper-direct: and that delta is the TRANSLATED input, not the raw partial',
    ok.includes('"partial_json":"{\\"command\\":\\"ls -la /tmp\\"}"'), JSON.stringify(ok));
}

// ======================================================================
header('fault 5 — upstream stalls past the read timeout');
// ======================================================================
// A stream that emits one event and then nothing. Without a read timeout the
// handler parks forever, holding its concurrency slot — the dario#905 shape,
// reached from the upstream side instead of the client side. The timeout is
// injected (upstreamTimeoutMs) so this costs a second, not the real 600s.
{
  mode = 'stall';
  const t0 = Date.now();
  const r = await stream({ messages: [{ role: 'user', content: 'hi' }] });
  const elapsed = Date.now() - t0;

  check('the stall ends — dario does not hang forever', elapsed < UPSTREAM_TIMEOUT_MS + 3_000, `${elapsed}ms`);
  check('and it ends at the timeout, not before (nothing else cut it short)',
    elapsed >= UPSTREAM_TIMEOUT_MS, `${elapsed}ms`);
  check('the one event that did arrive is not lost', events(r.text)[0] === 'message_start', r.text);
  // Reached by a different route than fault 1: the abort lands in the stream
  // loop's catch, so the outer `upstreamAbortReason === 'timeout'` branch that
  // would have written a 504 never runs — headers are long gone by then
  // anyway. So the terminal frame is the only way to say "timed out", and it
  // has to say timed out specifically: a client that can tell a stall from a
  // reset can decide whether retrying is worth anything.
  const t = checkTerminalError('read timeout', r.text, 'timeout_error');
  check('the timeout frame names the idle window rather than a generic failure',
    /mid-stream/.test(t.error?.error?.message ?? ''), JSON.stringify(t.error));
  check('and the event that did arrive is untouched ahead of it',
    t.upstreamBytes === PREFIX[0], JSON.stringify(t.upstreamBytes));
}

// ======================================================================
header('fault 6 — the same cuts, injected into the REAL recorded stream');
// ======================================================================
// Faults 1-5 use synthetic streams, which only prove dario handles the shapes
// this file imagined. This section cuts the recorded web-search turn — server
// tool, zero-delta result block, citation deltas — at three structurally
// interesting boundaries. The client request carries tools, so the streaming
// reverse-mapper is engaged throughout and has to leave every one of those
// blocks alone.
const WITH_TOOLS = {
  messages: [{ role: 'user', content: 'what is the latest zig release' }],
  tools: [
    EXEC_TOOL,
    // Deliberately collides by name with Anthropic's server tool. A client
    // tool called web_search must not cause the server_tool_use block coming
    // back to be reverse-mapped: server tools carry a `type` and no
    // input_schema, and renaming one would hand the client a tool call it has
    // no way to execute.
    { name: 'web_search', description: 'search the web', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  ],
};
{
  mode = 'recorded';
  const whole = await stream({ ...WITH_TOOLS, max_tokens: 512 });
  check('the recorded stream replays byte-identical through the proxy',
    whole.text === RECORDED,
    `${whole.text.length} bytes vs ${RECORDED.length}`);
  check('the server_tool_use block keeps Anthropic\'s own name even though the client claims a web_search tool',
    whole.text.includes('"name":"web_search"') && whole.text.includes('"type":"server_tool_use"'));
  check('the zero-delta web_search_tool_result block survives intact',
    whole.text.includes('"type":"web_search_tool_result"'));
  check('citations_delta passes through untouched',
    whole.text.includes('"type":"citations_delta"'));

  // Cut 1: mid server_tool_use, with the tool's JSON arguments half-sent.
  mode = startIndexOf('server_tool_use') + 4;
  const midToolJson = await stream({ ...WITH_TOOLS, max_tokens: 512 });
  const cut1 = checkTerminalError('cut mid server_tool_use', midToolJson.text, 'api_error');
  check('cut mid server_tool_use: everything upstream sent still reaches the client, byte for byte',
    cut1.upstreamBytes === recordedPrefix(mode), `${cut1.upstreamBytes.length} vs ${recordedPrefix(mode).length}`);
  check('cut mid server_tool_use: the partial input_json_delta is NOT swallowed (server tools bypass the tool-buffering path)',
    midToolJson.text.includes('"partial_json"'));
  check('cut mid server_tool_use: no message_stop is invented for a message that never ended',
    !midToolJson.text.includes('"type":"message_stop"'));

  // Cut 2: right after web_search_tool_result opens. That block's entire
  // payload rides in content_block_start and its stop is the very next event,
  // so this is the narrowest possible window — and the client is left holding
  // an unterminated result block.
  mode = startIndexOf('web_search_tool_result') + 1;
  const midResult = await stream({ ...WITH_TOOLS, max_tokens: 512 });
  const cut2 = checkTerminalError('cut at the zero-delta result block', midResult.text, 'api_error');
  check('cut at the zero-delta result block: prefix delivered exactly',
    cut2.upstreamBytes === recordedPrefix(mode), `${cut2.upstreamBytes.length} vs ${recordedPrefix(mode).length}`);
  check('cut at the zero-delta result block: the result content itself arrived (it lives in the start event)',
    midResult.text.includes('"type":"web_search_tool_result"'));
  check('cut at the zero-delta result block: the block is left open one event short of its stop, and the error frame says so rather than closing it',
    groupEvent(cut2.upstreamBytes.split('\n\n').filter(Boolean).at(-1)) === 'content_block_start');

  // Cut 3: mid citations, deep in the text blocks after the tool round trip.
  mode = RECORDED_GROUPS.findIndex((g) => groupData(g)?.delta?.type === 'citations_delta') + 1;
  const midCitation = await stream({ ...WITH_TOOLS, max_tokens: 512 });
  const cut3 = checkTerminalError('cut mid citations', midCitation.text, 'api_error');
  check('cut mid citations: prefix delivered exactly',
    cut3.upstreamBytes === recordedPrefix(mode), `${cut3.upstreamBytes.length} vs ${recordedPrefix(mode).length}`);
  check('cut mid citations: the citation the client did receive is intact and parseable',
    groupData(cut3.upstreamBytes.split('\n\n').filter(Boolean).at(-1))?.delta?.type === 'citations_delta');

  // The through-line across all three: dario delivers every byte it got, in
  // order, uncorrupted, and then says the stream was cut. The prefix
  // assertions above are the "loses nothing" half; the terminal frames are
  // the "and admits it" half. Neither is worth much without the other.
  check('none of the three cuts corrupted the bytes ahead of the terminal frame',
    [cut1, cut2, cut3].every((c) => RECORDED.startsWith(c.upstreamBytes)));

  // Token accounting. The authoritative count rides on message_delta, which a
  // cut stream never reaches, so a truncated stream used to book ZERO output
  // tokens while upstream had generated and charged for real ones. That
  // under-count was biased in one direction and landed entirely on the
  // traffic that failed, so the worse upstream behaved the more /analytics
  // understated the burn. It is now estimated from the characters dario
  // actually forwarded.
  const entries = await debugEntries();
  const cutEntries = entries.filter((e) => e.outcome === 'stream-error');
  check('a completed replay of the recording books its real output tokens',
    entries.some((e) => e.outcome !== 'stream-error' && e.outputTokens > 0),
    JSON.stringify(entries.map((e) => [e.req, e.outcome, e.outputTokens])));
  check('a truncated stream that forwarded real content no longer books zero output tokens',
    cutEntries.filter((e) => e.outputTokens > 0).length >= 3,
    JSON.stringify(cutEntries.map((e) => [e.req, e.outputTokens])));
  // A prefix cannot have generated more output than the whole stream did, so
  // every estimate has to sit under the measured figure. This is the bound
  // that catches an estimator counting the wrong bytes — an early version
  // that also counted the web_search_tool_result payload would blow straight
  // through it, since that block's content arrives in content_block_start
  // and is upstream's tool output rather than generated tokens.
  const measured = entries.find((e) => e.outcome !== 'stream-error' && e.outputTokens > 0)?.outputTokens;
  const deepest = Math.max(...cutEntries.map((e) => e.outputTokens));
  check('no cut estimates more output than the complete stream actually produced',
    measured > 0 && deepest < measured, `deepest=${deepest} measured=${measured}`);
  check('and a deeper cut estimates more than a shallower one — the figure tracks what was forwarded',
    (() => {
      const byDepth = cutEntries.filter((e) => /messages/.test(e.path)).map((e) => e.outputTokens);
      return new Set(byDepth).size > 1;
    })(), JSON.stringify(cutEntries.map((e) => [e.req, e.outputTokens])));
  // The measured figure must survive untouched. An estimate that overwrote a
  // real message_delta count would corrupt every healthy record to repair the
  // broken ones.
  check('a stream that DID reach message_delta keeps its measured count, not an estimate',
    measured === 169, String(measured));
}

// ======================================================================
header('fault 7 — upstream fails BEFORE any response headers');
// ======================================================================
// The other half of the timeout story. Faults 1 and 5 cut a stream that had
// already sent 200, so dario has no status line left to spend. Here nothing
// arrives at all, dario still owns the response, and it must answer in
// Anthropic's error shape with a request-id a user can quote in a bug report.
{
  for (const [faultMode, wantStatus, wantType, label] of [
    ['connect-refused', 502, 'api_error', 'the upstream connection is refused'],
    ['never-answers', 504, 'timeout_error', 'upstream never sends headers at all'],
  ]) {
    mode = faultMode;
    const t0 = Date.now();
    const res = await fetch(`${BASE}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const body = await res.json().catch(() => null);
    const elapsed = Date.now() - t0;

    check(`${label} → ${wantStatus}`, res.status === wantStatus, `${res.status} in ${elapsed}ms`);
    check(`${label}: body is Anthropic-shaped, not a bare string`,
      body?.type === 'error' && body.error?.type === wantType && typeof body.error?.message === 'string',
      JSON.stringify(body));
    check(`${label}: JSON content-type, not the text/event-stream the client asked for`,
      (res.headers.get('content-type') ?? '').startsWith('application/json'),
      String(res.headers.get('content-type')));
    check(`${label}: no SSE frame is emitted — the stream never opened`,
      !JSON.stringify(body).includes('event:'));

    // sendError mints a request-id per response and puts it in both places.
    // A support request that cannot name the failed call is unactionable, and
    // an id that only appears in one of the two is one an operator will
    // reasonably fail to find.
    const headerId = res.headers.get('request-id');
    check(`${label}: carries a request-id header`, /^req_dario_[0-9a-f]{32}$/.test(headerId ?? ''),
      String(headerId));
    check(`${label}: the body's request_id matches the header`, body?.request_id === headerId,
      `${body?.request_id} vs ${headerId}`);

    // Regression guard. sendError first shipped writing JSON_HEADERS alone,
    // which carries the security headers but neither CORS header — unlike
    // every success path and the 429 path, which spread CORS_RESPONSE_HEADERS.
    // A browser client got no Access-Control-Allow-Origin on any
    // dario-originated error, so it could not read the status, the body, or
    // the request-id just minted for it to quote: everything worked until
    // something failed, and then it failed opaquely. Fixed by spreading
    // CORS_RESPONSE_HEADERS in sendError; these two keep it that way.
    check(`${label}: is CORS-readable like every other response dario sends`,
      res.headers.get('access-control-allow-origin') !== null,
      String(res.headers.get('access-control-allow-origin')));
    check(`${label}: exposes Request-Id so a browser client can read the id sendError minted`,
      (res.headers.get('access-control-expose-headers') ?? '').toLowerCase().includes('request-id'),
      String(res.headers.get('access-control-expose-headers')));
  }

  // Two failures must not share an id — a reused one makes two incidents
  // indistinguishable in a log search, which is the whole point of having one.
  mode = 'connect-refused';
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`${BASE}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    ids.push(r.headers.get('request-id'));
    await r.text();
  }
  check('each originated error gets its own request-id', ids[0] !== ids[1], JSON.stringify(ids));

  // The timeout path must not be reachable by a client that simply asked for
  // a path dario does not serve — that one is a 404, and conflating them would
  // send an operator hunting an upstream problem that never happened.
  const notFound = await fetch(`${BASE}/v1/nope`);
  const nfBody = await notFound.json().catch(() => null);
  check('an unknown path is 404 not_found_error, not an upstream failure',
    notFound.status === 404 && nfBody?.error?.type === 'not_found_error',
    `${notFound.status} ${JSON.stringify(nfBody)}`);
  check('and it carries its own request-id too',
    /^req_dario_[0-9a-f]{32}$/.test(notFound.headers.get('request-id') ?? ''),
    String(notFound.headers.get('request-id')));
}

// ======================================================================
header('resource hygiene across every fault above');
// ======================================================================
{
  // The slot is released in the handler's `finally`, so it must be back
  // regardless of which failure path ran. A leak here wedges the proxy: with
  // maxConcurrent slots leaked, every later request 504s queue-timeout while
  // /health stays green.
  const q = await queueSnapshot();
  check('no queue slot leaked by any fault', q.active === 0 && q.queued === 0, JSON.stringify(q));

  // The follow-up request is the real victim of a leak, so prove one still
  // gets served rather than trusting the counter.
  mode = 'healthy';
  const after = await stream({ messages: [{ role: 'user', content: 'ping' }] });
  check('a healthy request after five faults is still served end to end',
    after.status === 200 && events(after.text).at(-1) === 'message_stop', events(after.text).join(' '));

  // /debug/requests is where the truncation IS visible. Each faulted stream
  // must carry outcome:'stream-error' plus the reason, or an operator staring
  // at a 200 has no way to tell a cut stream from a short answer.
  const entries = await debugEntries();
  const streamErrors = entries.filter((e) => e.outcome === 'stream-error');
  check('every truncated stream is recorded with outcome=stream-error (5 socket deaths + 1 stall)',
    streamErrors.length === 6, `${streamErrors.length} of ${entries.length}: ${JSON.stringify(entries.map((e) => [e.req, e.status, e.outcome]))}`);
  check('the socket death records the upstream reason, not a generic label',
    streamErrors.filter((e) => /ECONNRESET/.test(e.error ?? '')).length === 5,
    JSON.stringify(streamErrors.map((e) => e.error)));
  check('the stall records an abort reason distinct from the socket death',
    new Set(streamErrors.map((e) => e.error)).size === 2, JSON.stringify(streamErrors.map((e) => e.error)));
  check('both routes are represented — the Anthropic and OpenAI stream paths fail the same way',
    new Set(streamErrors.map((e) => e.path)).size === 2, JSON.stringify(streamErrors.map((e) => e.path)));

  // The pre-header faults are a different outcome class: dario still owned the
  // response, so they must not be filed alongside the truncated streams.
  check('a pre-header failure is recorded as network-error / timeout, not stream-error',
    entries.filter((e) => e.outcome === 'network-error').length === 3
      && entries.filter((e) => e.outcome === 'timeout').length === 1,
    JSON.stringify(entries.map((e) => [e.req, e.status, e.outcome])));
  check('a clean stream is recorded as complete, so the flag actually discriminates',
    entries.some((e) => e.outcome === undefined || e.outcome === 'complete'));

  // …and analytics has to agree with it. The record carries upstream.status,
  // which was 200 before the stream broke, so status alone books a truncated
  // stream as a success — and errorRate is the number an operator watches to
  // decide whether upstream is healthy. Two surfaces disagreeing about
  // whether one request succeeded is the failure mode surface-agreement.mjs
  // exists for; the streamTruncated flag is what keeps them in step.
  const summary = await (await fetch(`${BASE}/analytics`)).json();
  const truncated = entries.filter((e) => e.outcome === 'stream-error').length;
  check('errorRate counts mid-stream failures, not just 4xx/5xx statuses',
    summary.allTime.errorRate > 0, String(summary.allTime.errorRate));
  check('and counts exactly the requests /debug/requests calls stream-error — the two surfaces agree on the same verdict',
    Math.round(summary.allTime.errorRate * summary.allTime.requests) === truncated,
    `errorRate=${summary.allTime.errorRate} requests=${summary.allTime.requests} truncated=${truncated}`);
  check('a healthy stream is still not counted as an error',
    summary.allTime.errorRate < 1, String(summary.allTime.errorRate));
}

await proxy.close();

// ======================================================================
header('fault 8 — 429 with retry-after on the request that opens the stream');
// ======================================================================
// Needs a pool: the question is not only whether the header reaches the client
// but whether the account it burned is cooled down. A single-account pool
// makes the cool-down observable — with nothing to fail over to, /status has
// to admit the pool is unusable rather than reporting healthy while every
// request 429s.
{
  const accountsDir = join(home, '.dario', 'accounts');
  await mkdir(accountsDir, { recursive: true });
  await writeFile(join(accountsDir, 'solo.json'), JSON.stringify({
    alias: 'solo',
    accessToken: 'token-solo',
    refreshToken: 'refresh-solo',
    expiresAt: Date.now() + 8 * 60 * 60_000,  // far enough out that no refresh fires
    scopes: ['user:inference'],
    deviceId: 'device-solo',
    accountUuid: 'account-solo',
  }));

  const poolProxy = await startProxy({
    port: 0, host: '127.0.0.1',
    fetchImpl: faultingFetch, noLiveCapture: true,
    upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
  });
  const POOL_BASE = `http://127.0.0.1:${poolProxy.port}`;
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${POOL_BASE}/health`); break; } catch { await sleep(100); }
  }

  try {
    const before = await (await fetch(`${POOL_BASE}/status`)).json();
    check('the pool starts healthy with its one account', before.accounts === 1 && before.status !== 'broken',
      JSON.stringify(before));

    mode = '429-retry-after';
    const res = await fetch(`${POOL_BASE}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const body = await res.json();

    check('the 429 reaches the client as a 429', res.status === 429, String(res.status));
    check('retry-after is forwarded verbatim — it is what drives the SDK\'s backoff, and dropping it turns a paced retry into a hot loop',
      res.headers.get('retry-after') === '37', String(res.headers.get('retry-after')));
    check('x-should-retry survives too', res.headers.get('x-should-retry') === 'true',
      String(res.headers.get('x-should-retry')));
    check('CORS exposes Retry-After so a browser client can read it at all',
      (res.headers.get('access-control-expose-headers') ?? '').toLowerCase().includes('retry-after'),
      String(res.headers.get('access-control-expose-headers')));
    check('the body keeps the rate_limit_error type', body?.error?.type === 'rate_limit_error', JSON.stringify(body));
    check('and Anthropic\'s bare "Error" message is enriched from the rate-limit headers',
      /five_hour/.test(body?.error?.message ?? '') && /resets in/.test(body?.error?.message ?? ''),
      JSON.stringify(body?.error?.message));
    check('no SSE frame is emitted for a 429 — the stream never opened',
      !JSON.stringify(body).includes('event:'));

    // The cool-down. markRejected takes retry-after as a hint, so the account
    // is out of rotation; with no peer, the honest answer from /status is that
    // nothing can serve.
    const after = await (await fetch(`${POOL_BASE}/status`)).json();
    check('the 429 cools the account down — /status reports the pool as unusable, not healthy',
      after.status === 'broken', JSON.stringify(after));
    check('and says why, so the operator is not left guessing',
      /rate-limited/.test(after.expiresIn ?? ''), JSON.stringify(after.expiresIn));

    // While the cool-down holds, dario refuses rather than burning the
    // account into a second 429 (which would only escalate the backoff rung).
    // The refusal has to say so — a bare 503 is indistinguishable from a dead
    // proxy, and the caller needs to know this one is worth retrying.
    mode = 'healthy';
    const during = await fetch(`${POOL_BASE}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const duringBody = await during.json().catch(() => ({}));
    check('a request during the cool-down is refused, not sent into a second 429',
      during.status === 503, String(during.status));
    check('and the refusal names the cause and says it is transient',
      /rate-limited/.test(JSON.stringify(duringBody)) && /retry/i.test(JSON.stringify(duringBody)),
      JSON.stringify(duringBody));

    // The hygiene ask: the fault must not outlive itself. A rejected account
    // has to be cooled DOWN, not switched off — bounded, scoped, and still
    // enabled, so it comes back without an operator touching anything.
    const view = await (await fetch(`${POOL_BASE}/accounts`)).json();
    const solo = view.accounts?.find((a) => a.alias === 'solo');
    check('the 429\'d account is still enabled — a rate limit is not a disable',
      solo?.enabled === true, JSON.stringify(solo));
    check('its cool-down is bounded and takes the retry-after/reset hint rather than a stock backoff',
      typeof solo?.cooldownMs === 'number' && solo.cooldownMs > 0 && solo.cooldownMs <= 95_000,
      String(solo?.cooldownMs));
    check('and it is scoped to the rate-limit bucket, not applied account-wide',
      Array.isArray(solo?.cooldownScopes) && solo.cooldownScopes.length > 0,
      JSON.stringify(solo?.cooldownScopes));
    check('no auth-failure state was invented from a 429',
      solo?.consecutiveAuthFailures === undefined && solo?.refreshError === undefined,
      JSON.stringify(solo));

    const q = await (await fetch(`${POOL_BASE}/analytics`)).json();
    check('the 429 leaked no queue slot either', q.queue.active === 0 && q.queue.queued === 0,
      JSON.stringify(q.queue));
  } finally {
    await poolProxy.close();
  }
}

// ======================================================================
console.log(`\n${pass} passed, ${fail} failed${gatedOff > 0 ? `, ${gatedOff} gated off (DARIO_STREAM_STRICT=1 to enforce)` : ''}`);
process.exit(fail === 0 ? 0 : 1);
