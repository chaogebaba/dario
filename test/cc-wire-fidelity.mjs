#!/usr/bin/env bun
/**
 * Wire fidelity against recorded Claude Code traffic.
 *
 * Every other CC-shape suite in this repo asserts what someone believed CC
 * sends. This one asserts what CC was observed sending. The fixtures under
 * test/fixtures/cc-wire-2.1.236/ are a MITM recording of real Claude Code
 * v2.1.236 talking to api.anthropic.com: `ANTHROPIC_BASE_URL` pointed at a
 * logging reverse proxy, real subscription credentials, a sandboxed HOME and
 * CLAUDE_CONFIG_DIR, and — for the interactive and /compact captures — a real
 * TTY session driven under tmux. index.json records what was scrubbed.
 *
 * The recording settled six things that reading the code had got wrong:
 *
 *   1. `/compact` is not a distinct system prompt. It sends the ordinary
 *      main-loop system array and puts the summariser instruction in the last
 *      USER message. An earlier comment in cc-template.ts claimed otherwise.
 *   2. CC varies `anthropic-beta` by request KIND, not by model — five
 *      different lists across six consecutive requests from one session.
 *   3. CC fires a quota probe with no `system` key at all.
 *   4. CC 2.1.236 sends no `x-client-request-id`, and sends
 *      `x-stainless-timeout` on /v1/messages but not on count_tokens.
 *   5. api.anthropic.com answers /api/hello with `{"message":"hello"}`.
 *   6. Upstream sends `anthropic-workspace-id`, which CC reads.
 *
 * Refreshing after a CC release: DARIO_LIVE_CC=1 re-records against the
 * installed bundle and diffs (see the last section). The default run is
 * hermetic — no network, no credentials, no `claude` binary.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  isGenuineCCClient, hasCCIdentityHeaders, buildCCRequest,
} from '../dist/cc-template.js';
import {
  startProxy, isForwardableUpstreamHeader, dedupeBetaFlags,
} from '../dist/proxy.js';

let pass = 0, fail = 0;
function check(label, cond, ...rest) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`, ...rest); }
}
function header(name) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}

const DIR = join(import.meta.dirname, 'fixtures', 'cc-wire-2.1.236');
const index = JSON.parse(readFileSync(join(DIR, 'index.json'), 'utf8'));
const shape = (name) => JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8'));
const SHAPES = Object.fromEntries(index.captures.map((c) => [c.name, shape(c.name)]));
const FULL = JSON.parse(readFileSync(join(DIR, 'compaction.full.json'), 'utf8'));

// ======================================================================
header('the corpus is what it claims to be');
{
  check(`index lists ${index.captures.length} captures and every file exists`,
    index.captures.length >= 8
    && index.captures.every((c) => existsSync(join(DIR, c.file))));
  check('every CC-issued capture came from CC 2.1.236',
    Object.values(SHAPES).filter((s) => s.request.method === 'POST')
      .every((s) => s.request.headers['user-agent']?.startsWith('claude-cli/2.1.236 ')));
  // CC's /api/hello probe is a bare fetch with no identity headers — it goes
  // out under the embedded runtime's default user-agent, not claude-cli's.
  // The api-hello fixtures are here for the RESPONSE api.anthropic.com gives.
  check('CC\'s /api/hello probe carries no CC identity headers',
    !hasCCIdentityHeaders(SHAPES['api-hello-head'].request.headers));
  check('no credential survived the scrub',
    !readdirSync(DIR).some((f) =>
      /sk-ant-|Bearer [A-Za-z0-9]|eyJ[A-Za-z0-9_-]{10}/.test(readFileSync(join(DIR, f), 'utf8'))));
  check('only the three paths CC asks a proxy for',
    new Set(index.captures.map((c) => c.url.split('?')[0]))
      .isSubsetOf(new Set(['/v1/messages', '/v1/messages/count_tokens', '/api/hello'])));
}

// ======================================================================
header('every recorded CC request is recognised as CC');
{
  for (const [name, s] of Object.entries(SHAPES)) {
    if (s.request.method !== 'POST') continue;
    const body = {};
    if (Array.isArray(s.request.systemBlocks)) {
      // Reconstruct just enough system for the predicate: the recorded block
      // count and the real first-block text, which is what it reads.
      body.system = s.request.systemBlocks.map((b, i) => ({
        type: 'text',
        text: i === 0 ? 'x-anthropic-billing-header: cc_version=2.1.236.ce1; cc_entrypoint=cli;' : `block ${i}`,
      }));
    }
    check(`${name} → CC`, isGenuineCCClient(body, s.request.headers));
  }
  check('the quota probe needs its headers to be recognised — body alone is not enough',
    !isGenuineCCClient({}) && isGenuineCCClient({}, SHAPES['quota-probe'].request.headers));
}

// ======================================================================
header('hasCCIdentityHeaders — recorded values in, forgeries out');
{
  for (const [name, s] of Object.entries(SHAPES)) {
    if (s.request.method !== 'POST') continue;
    check(`${name} headers read as CC`, hasCCIdentityHeaders(s.request.headers));
  }
  const real = SHAPES['main-loop'].request.headers;
  check('user-agent alone is not enough', !hasCCIdentityHeaders({ 'user-agent': real['user-agent'] }));
  check('x-app alone is not enough', !hasCCIdentityHeaders({ 'x-app': 'cli' }));
  check('a wrapper\'s own user-agent is rejected',
    !hasCCIdentityHeaders({ 'user-agent': 'Cline/3.2.1', 'x-app': 'cli' }));
  check('a truncated claude-cli UA is rejected',
    !hasCCIdentityHeaders({ 'user-agent': 'claude-cli/2.1.236', 'x-app': 'cli' }));
  check('x-app must be exactly cli',
    !hasCCIdentityHeaders({ 'user-agent': real['user-agent'], 'x-app': 'vscode' }));
}

// ======================================================================
header('/compact is a main-loop request, not a summariser prompt');
{
  // The finding that motivated the recording. dario's detector used to be an
  // allowlist of system-prompt openers, and the note justifying its removal
  // asserted that the /compact summariser had its own prompt and was therefore
  // missed. It does not, and it was not.
  const sys = FULL.request.body.system;
  check('system[0] is the billing block', sys[0].text.startsWith('x-anthropic-billing-header:'));
  check('system[1] is the ordinary CC opener',
    sys[1].text === "You are Claude Code, Anthropic's official CLI for Claude.");
  check('system[2] is the ordinary main-loop prompt',
    sys[2].text.includes('You are an interactive agent that helps users with software engineering tasks.'));
  const last = FULL.request.body.messages.at(-1);
  const lastText = last.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  check('the summariser instruction rides in the LAST USER message',
    last.role === 'user' && lastText.includes('create a detailed summary of the conversation'));
  check('compaction still carries the full tool set (it is not a bare call)',
    FULL.request.body.tools.length === 55);
  check('so the pre-2026-08 opener allowlist would have matched it',
    sys[1].text.startsWith('You are Claude Code'));
}

// ======================================================================
header('CC varies anthropic-beta by request kind — no per-model rule reproduces it');
{
  const betas = Object.fromEntries(Object.entries(SHAPES)
    .filter(([, s]) => s.request.headers['anthropic-beta'])
    .map(([n, s]) => [n, s.request.headers['anthropic-beta']]));
  const distinct = new Set(Object.values(betas));
  check(`${Object.keys(betas).length} recorded requests carry ${distinct.size} distinct beta lists`,
    distinct.size >= 4);
  check('all of them ran on the same model',
    new Set(Object.entries(SHAPES).filter(([n]) => n in betas)
      .map(([, s]) => s.request.scalars.model)).size === 1);
  check('the main loop carries extended-cache-ttl and compaction does not',
    betas['main-loop'].includes('extended-cache-ttl-')
      && !betas['compaction'].includes('extended-cache-ttl-'));
  check('the title generator carries structured-outputs and nothing else does',
    betas['session-title'].includes('structured-outputs-')
      && !betas['main-loop'].includes('structured-outputs-'));
  check('count_tokens carries a four-flag list of its own',
    betas['count-tokens'].split(',').length === 4);
  check('every list starts with oauth-2025-04-20',
    Object.values(betas).every((b) => b.startsWith('oauth-2025-04-20')));
  check('no list repeats a flag',
    Object.values(betas).every((b) => dedupeBetaFlags(b) === b));
  check('dedupeBetaFlags keeps first position, never sorts',
    dedupeBetaFlags('oauth-2025-04-20,b,oauth-2025-04-20,a') === 'oauth-2025-04-20,b,a');
}

// ======================================================================
header('buildCCRequest leaves a recorded CC body alone');
{
  const client = structuredClone(FULL.request.body);
  const { body, genuineCC } = buildCCRequest(
    structuredClone(FULL.request.body),
    'x-anthropic-billing-header: cc_version=9.9.9.zzz; cc_entrypoint=DARIO-TEMPLATE;',
    { type: 'ephemeral' },
    { deviceId: 'dario-dev', accountUuid: 'dario-acct', sessionId: 'dario-sess' },
    { clientHeaders: FULL.request.headers },
  );
  check('recognised as CC', genuineCC === true);
  check('top-level key order identical',
    Object.keys(body).join(',') === Object.keys(client).join(','));
  check('system identical, billing block included',
    JSON.stringify(body.system) === JSON.stringify(client.system));
  check('messages identical, cache_control positions included',
    JSON.stringify(body.messages) === JSON.stringify(client.messages));
  check('all 55 tool schemas identical and in order',
    JSON.stringify(body.tools) === JSON.stringify(client.tools));
  check('thinking / context_management / max_tokens untouched',
    JSON.stringify(body.thinking) === JSON.stringify(client.thinking)
      && JSON.stringify(body.context_management) === JSON.stringify(client.context_management)
      && body.max_tokens === client.max_tokens);
  const uid = JSON.parse(body.metadata.user_id);
  check('metadata.user_id is dario\'s — the only field dario owns here',
    uid.device_id === 'dario-dev' && uid.account_uuid === 'dario-acct');

  // Breakpoints: CC put one on messages[1] and none on messages[0]/[2].
  // dario used to strip that and stamp its own, taking 3 breakpoints to 4.
  const bp = (b) => b.messages.flatMap((m, i) =>
    (Array.isArray(m.content) ? m.content : []).map((c, j) => c.cache_control ? `${i}.${j}` : null)).filter(Boolean);
  check('conversation breakpoints stay exactly where CC put them',
    bp(body).join(',') === bp(client).join(','));
  check('the recording really does have a single conversation breakpoint',
    bp(client).length === 1);
}

// ======================================================================
header('the quota probe survives contact with the template');
{
  const probe = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'quota' }],
    metadata: { user_id: 'client' },
  };
  const before = JSON.stringify(probe).length;
  const { body, genuineCC } = buildCCRequest(
    structuredClone(probe), 'billing', { type: 'ephemeral' },
    { deviceId: 'd', accountUuid: 'a', sessionId: 's' },
    { clientHeaders: SHAPES['quota-probe'].request.headers },
  );
  check('recognised as CC via headers', genuineCC === true);
  check('no system block invented', body.system === undefined);
  check('no tools invented', body.tools === undefined);
  check('max_tokens still 1 (it asks for one token on purpose)', body.max_tokens === 1);
  check('key order preserved', Object.keys(body).join(',') === Object.keys(probe).join(','));
  check(`stays small (${JSON.stringify(body).length}B vs ${before}B in)`,
    JSON.stringify(body).length < before + 300);

  // Without the headers it is indistinguishable from any other bare request,
  // and the template path is the right answer for those.
  const noHeaders = buildCCRequest(structuredClone(probe), 'billing', { type: 'ephemeral' },
    { deviceId: 'd', accountUuid: 'a', sessionId: 's' }, {});
  check('a bare body with no CC headers still gets the template',
    noHeaders.genuineCC !== true && Array.isArray(noHeaders.body.system));
}

// ======================================================================
header('response headers — forward what CC reads, drop the infrastructure');
{
  // The header names below are the ones the recorded upstream responses
  // actually carried, split by whether the CC bundle parses them.
  const recorded = new Set(Object.values(SHAPES).flatMap((s) => s.response.headerNames ?? []));
  check('the recording captured a full rate-limit header family',
    [...recorded].filter((h) => h.startsWith('anthropic-ratelimit')).length >= 10);

  const CC_READS = [...recorded].filter((h) =>
    h.startsWith('anthropic-ratelimit') || h === 'anthropic-organization-id'
    || h === 'anthropic-workspace-id' || h === 'request-id');
  for (const h of CC_READS) check(`forwards ${h}`, isForwardableUpstreamHeader(h));

  // Not in this recording (no 429 was provoked) but the two headers whose
  // whole job is arbitrating a retry — CC has its own heuristics and falls
  // back to them when these are missing.
  check('forwards retry-after', isForwardableUpstreamHeader('retry-after'));
  check('forwards x-should-retry', isForwardableUpstreamHeader('x-should-retry'));

  const INFRA = ['cf-ray', 'cf-cache-status', 'server', 'date', 'vary', 'x-robots-tag',
    'content-security-policy', 'strict-transport-security', 'traceresponse',
    'content-encoding', 'transfer-encoding', 'connection'];
  for (const h of INFRA) {
    check(`does not forward ${h}`, !isForwardableUpstreamHeader(h));
    check(`  …and upstream really did send ${h}`, recorded.has(h));
  }
}

// ======================================================================
header('SSE — the recorded event stream, as CC would see it');
{
  const sse = SHAPES['compaction'].response.sse;
  check('opens with message_start', sse[0].event === 'message_start');
  check('closes with message_stop', sse.at(-1).event === 'message_stop');
  check('carries a ping', sse.some((e) => e.event === 'ping'));
  check('every event has a parseable data payload except the padded ones',
    sse.every((e) => e.dataKeys !== null));
  check('message_delta reports stop_reason and usage',
    sse.find((e) => e.event === 'message_delta')?.dataKeys.includes('usage'));
  check('upstream pads data lines with trailing spaces (anti-buffering)',
    sse.some((e) => e.padded));
  const order = sse.map((e) => e.event).join(' ');
  check('block events are properly nested',
    /content_block_start( ping)?( content_block_delta)+ content_block_stop/.test(order));
}

// ======================================================================
header('live: through the assembled proxy');
{
  let captured = null;
  const fakeFetch = async (url, init) => {
    if (String(url).includes('/v1/messages')) {
      let raw = init?.body;
      if (raw && typeof raw !== 'string') raw = new TextDecoder().decode(raw);
      // dario hands fetch an ARRAY of [name, value] pairs — header order is
      // part of the wire shape it replays, and an object literal would lose it.
      const h = {};
      const rh = init?.headers;
      if (Array.isArray(rh)) for (const [k, v] of rh) h[String(k).toLowerCase()] = String(v);
      else if (rh && typeof rh === 'object') for (const [k, v] of Object.entries(rh)) h[String(k).toLowerCase()] = String(v);
      captured = { headers: h, headerOrder: Array.isArray(rh) ? rh.map(([k]) => String(k)) : Object.keys(h), body: JSON.parse(raw) };
    }
    // Replay the recorded upstream response, bytes and all.
    return new Response(FULL.response.body, {
      status: FULL.response.status,
      headers: {
        'content-type': FULL.response.contentType,
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-workspace-id': 'wrkspc_fixture',
        'anthropic-organization-id': 'org_fixture',
        'request-id': 'req_fixture',
        'cf-ray': 'should-not-reach-the-client',
      },
    });
  };

  const proxy = await startProxy({
    port: 0, host: '127.0.0.1',
    upstreamApiKey: 'sk-ant-test-not-a-real-key',
    noClaudeAuth: true, fetchImpl: fakeFetch, noLiveCapture: true,
  });
  const BASE = `http://127.0.0.1:${proxy.port}`;
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  try {
    // ── /api/hello: the one status a CC client can observe without a message
    for (const method of ['GET', 'HEAD']) {
      const want = SHAPES[`api-hello-${method.toLowerCase()}`].response;
      const res = await fetch(`${BASE}/api/hello`, { method });
      const text = await res.text();
      check(`${method} /api/hello → ${want.status}`, res.status === want.status);
      check(`${method} /api/hello content-type matches api.anthropic.com`,
        res.headers.get('content-type')?.startsWith('application/json'));
      if (method === 'GET') {
        check('GET /api/hello body matches api.anthropic.com byte for byte',
          text === JSON.stringify(SHAPES['api-hello-get'].response.body));
      } else {
        check('HEAD /api/hello has no body', text === '');
      }
    }

    // ── the full compaction capture, replayed
    const hdrs = { ...FULL.request.headers, authorization: 'Bearer sk-ant-oat01-replay' };
    const res = await fetch(BASE + FULL.request.url, {
      method: 'POST', headers: hdrs, body: JSON.stringify(FULL.request.body),
    });
    const body = await res.text();

    check('client gets 200', res.status === 200);
    check('SSE reaches the client byte-identical to what upstream sent',
      body === FULL.response.body);
    check('anthropic-workspace-id reaches the client', res.headers.get('anthropic-workspace-id') === 'wrkspc_fixture');
    check('request-id reaches the client', res.headers.get('request-id') === 'req_fixture');
    check('rate-limit headers reach the client', res.headers.get('anthropic-ratelimit-unified-status') === 'allowed');
    check('cf-ray does not', res.headers.get('cf-ray') === null);

    check('something reached upstream', captured !== null);
    if (captured) {
      const want = FULL.request.body;
      check('upstream body key order matches the recording',
        Object.keys(captured.body).join(',') === Object.keys(want).join(','));
      check('upstream system identical to the recording',
        JSON.stringify(captured.body.system) === JSON.stringify(want.system));
      check('upstream messages identical to the recording',
        JSON.stringify(captured.body.messages) === JSON.stringify(want.messages));
      check('upstream tools identical to the recording',
        JSON.stringify(captured.body.tools) === JSON.stringify(want.tools));
      check('anthropic-beta forwarded verbatim, order included',
        captured.headers['anthropic-beta'] === FULL.request.headers['anthropic-beta']);
      check('user-agent forwarded verbatim',
        captured.headers['user-agent'] === FULL.request.headers['user-agent']);
      check('x-app forwarded verbatim', captured.headers['x-app'] === FULL.request.headers['x-app']);

      // Headers CC did not send must not appear. Synthesising one is the same
      // kind of tell as dropping one CC did send.
      for (const h of ['x-client-request-id']) {
        check(`${h} not invented (CC 2.1.236 sends none)`, !(h in captured.headers));
      }
      // The two deliberate deltas.
      check('metadata.user_id replaced with dario\'s identity',
        captured.body.metadata.user_id !== want.metadata.user_id);
      check('x-claude-code-session-id rotated (dario owns session identity)',
        captured.headers['x-claude-code-session-id'] !== FULL.request.headers['x-claude-code-session-id']);
    }

    // ── the one flag dario adds to a forwarded list, and why
    // `[1m]` is dario's own model suffix; CC has never heard of it, so a CC
    // pointed at `claude-opus-5[1m]` asks for the 1M window without sending
    // the flag that enables it. That is the single case where forwarding the
    // client's list verbatim would lose something the client meant.
    captured = null;
    await (await fetch(BASE + FULL.request.url, {
      method: 'POST', headers: hdrs,
      body: JSON.stringify({ ...FULL.request.body, model: 'claude-opus-5[1m]' }),
    })).text();
    check('a [1m] model gets context-1m added to the forwarded list',
      captured?.headers['anthropic-beta'].split(',').includes('context-1m-2025-08-07'));
    check('and the [1m] suffix is stripped off the model going upstream',
      captured?.body.model === 'claude-opus-5');

    captured = null;
    await (await fetch(BASE + FULL.request.url, {
      method: 'POST', headers: hdrs,
      body: JSON.stringify({ ...FULL.request.body, model: 'claude-opus-5' }),
    })).text();
    check('a plain model gets nothing added — CC does not send it either',
      captured?.headers['anthropic-beta'] === FULL.request.headers['anthropic-beta']);

    // ── count_tokens is thin, and thin must not mean "template-flavoured"
    const ct = SHAPES['count-tokens'];
    captured = null;
    let ctCaptured = null;
    const ctBody = { model: ct.request.scalars.model, messages: [{ role: 'user', content: 'trailing newline matters\n' }], tools: [] };
    const ctRes = await fetch(`${BASE}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { ...ct.request.headers, authorization: 'Bearer sk-ant-oat01-replay' },
      body: JSON.stringify(ctBody),
    });
    await ctRes.text();
    ctCaptured = captured;
    check('count_tokens reached upstream', ctCaptured !== null);
    if (ctCaptured) {
      check('count_tokens forwards CC\'s own user-agent, not the template\'s',
        ctCaptured.headers['user-agent'] === ct.request.headers['user-agent']);
      check('count_tokens does not grow x-stainless-timeout (CC omits it there)',
        !('x-stainless-timeout' in ctCaptured.headers) && !('x-stainless-timeout' in ct.request.headers));
      check('count_tokens beta has no duplicate flag',
        dedupeBetaFlags(ctCaptured.headers['anthropic-beta']) === ctCaptured.headers['anthropic-beta']);
      check('the prompt being counted is not edited on the way',
        ctCaptured.body.messages[0].content === 'trailing newline matters\n');
    }
  } finally {
    await proxy.close?.();
  }
}

// ======================================================================
header('drift: re-record against the installed Claude Code');
{
  // Opt-in. Spawns the real `claude` against a throwaway MITM, so it needs
  // credentials, network, and burns a little quota. CI runs the sections above
  // instead, which is why they read from fixtures rather than from a live CC.
  if (process.env.DARIO_LIVE_CC !== '1') {
    console.log('  SKIP: set DARIO_LIVE_CC=1 to re-record against the installed bundle');
  } else {
    const { createServer } = await import('node:http');
    const { spawn } = await import('node:child_process');
    const { mkdtemp, writeFile, mkdir, copyFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    const home = await mkdtemp(join(tmpdir(), 'dario-live-cc-'));
    const seen = [];
    const rec = createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      if (req.url.startsWith('/v1/messages')) {
        // Every request, not just the first: one `claude -p` fires the title
        // generator, the main loop, and sometimes count_tokens, in an order
        // that is not stable. Matching a fixture to whichever arrived first
        // compares a title-generator request against a main-loop capture and
        // reports drift that is really just a different request kind.
        seen.push({
          url: req.url,
          headers: { ...req.headers },
          body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
        });
      }
      const up = await fetch('https://api.anthropic.com' + req.url, {
        method: req.method,
        headers: Object.fromEntries(Object.entries(req.headers)
          .filter(([k]) => !['host', 'content-length', 'connection'].includes(k))),
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
      });
      res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json' });
      res.end(Buffer.from(await up.arrayBuffer()));
    });
    await new Promise((r) => rec.listen(0, '127.0.0.1', r));
    const port = rec.address().port;

    try {
      await mkdir(join(home, '.claude'), { recursive: true });
      await copyFile(join(process.env.HOME, '.claude', '.credentials.json'), join(home, '.claude', '.credentials.json'));
      await writeFile(join(home, '.claude', 'settings.json'), '{}');
      await new Promise((resolve) => {
        const cp = spawn('claude', ['-p', 'Say PONG', '--model', 'claude-haiku-4-5-20251001'], {
          cwd: home,
          env: {
            HOME: home, PATH: process.env.PATH, TERM: 'dumb',
            CLAUDE_CONFIG_DIR: join(home, '.claude'),
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
          },
          stdio: 'ignore',
        });
        cp.on('exit', resolve);
        setTimeout(() => { cp.kill(); resolve(); }, 120_000);
      });

      check('live CC reached the recorder', seen.length > 0);

      const ver = seen.map((r) => /cc_version=([\d.]+)/.exec(r.body.system?.[0]?.text ?? '')?.[1]).find(Boolean);
      if (ver && !ver.startsWith(index.ccVersion)) {
        console.log(`  NOTE: installed CC is ${ver}, fixtures are ${index.ccVersion}`);
      }

      // Pair each live request with the fixture that has the same top-level
      // key order — that is what identifies a request KIND, and it is the
      // first thing that drifts when CC changes its wire shape.
      // Keyed on entrypoint too, because they are not the same client. CC
      // under `-p` announces cc_entrypoint=sdk-cli and sends a different beta
      // list from the interactive `cli` entrypoint on an identically-shaped
      // body — the headless title generator omits redact-thinking, which the
      // interactive main loop sends. Pairing on key order alone compares those
      // two and calls the difference drift.
      const entrypoint = (blocks) => Array.isArray(blocks)
        ? /cc_entrypoint=([a-z-]+)/.exec(JSON.stringify(blocks))?.[1] ?? '?'
        : '?';
      const fixtureKey = (f) => `${f.bodyKeyOrder.join(',')}|${f.headers['user-agent']?.match(/\(external, ([^)]+)\)/)?.[1] ?? '?'}`;
      const byKeyOrder = new Map(Object.entries(SHAPES)
        .filter(([, f]) => f.request.method === 'POST' && f.request.bodyKeyOrder)
        .map(([n, f]) => [fixtureKey(f.request), { name: n, req: f.request }]));

      const unmatched = [];
      let compared = 0;
      for (const live of seen) {
        const key = `${Object.keys(live.body).join(',')}|${entrypoint(live.body.system)}`;
        const fixture = byKeyOrder.get(key);
        if (!fixture) { unmatched.push(`${live.url} → ${key}`); continue; }
        compared++;
        const want = fixture.req;
        const drift = [];
        for (const k of Object.keys(want.headers)) {
          // Per-session or per-host by nature; drift in these says nothing.
          if (['x-claude-code-session-id', 'user-agent', 'x-stainless-runtime-version',
            'x-stainless-os', 'x-stainless-arch'].includes(k)) continue;
          if (live.headers[k] !== want.headers[k]) drift.push(`${k}:\n       fixture ${want.headers[k]}\n       live    ${live.headers[k]}`);
        }
        check(`${fixture.name}: no header drift vs the ${index.ccVersion} fixture`,
          drift.length === 0, '\n     ' + drift.join('\n     '));
        if (Array.isArray(want.systemBlocks)) {
          check(`${fixture.name}: system block count unchanged`,
            live.body.system?.length === want.systemBlocks.length);
        }
      }
      check(`at least one live request matched a fixture kind (${compared}/${seen.length})`,
        compared > 0);
      // A shape with no fixture is news, not a failure: this run may simply
      // not have exercised it, or CC may have grown one. Say so either way.
      if (unmatched.length) {
        console.log(`  NOTE: ${unmatched.length} live request shape(s) match no fixture:\n     ${unmatched.join('\n     ')}`);
      }
    } finally {
      rec.close();
      await rm(home, { recursive: true, force: true });
    }
  }
}

console.log(`\n${'='.repeat(70)}\n  ${pass} pass, ${fail} fail\n${'='.repeat(70)}`);
process.exit(fail === 0 ? 0 : 1);
