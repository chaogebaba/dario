#!/usr/bin/env bun
// Differential fidelity: what real CC sent, versus what dario sends when real
// CC sends it.
//
// Every other CC-shape suite in this repo answers "does dario produce the shape
// someone believes CC produces". This one answers the question the fork
// actually has: dario fronts real Claude Code and nothing else, so any
// difference between the request that arrived and the request that left is a
// difference api.anthropic.com can see, and every one of them has to be
// deliberate.
//
// Method: reconstruct each recorded 2.1.239 shape from
// test/fixtures/cc-wire-2.1.239/ — the same top-level key order, the same
// system-block structure and cache_control, the same declared tools, the same
// header order — send it through a real startProxy, and intercept the outbound
// request with a fetchImpl. Then diff.
//
// The reconstruction carries filler where the fixture carries lengths, because
// the fixtures are shape-only by construction: the recording is real traffic
// and its content is the operator's. That costs nothing here. dario's genuine-CC
// path is explicitly byte-faithful about the body — it forwards messages,
// tools, thinking, effort, max_tokens and key order untouched — so a passthrough
// break shows up in the SHAPE, which is exactly what survived scrubbing.
//
// The allowlist below is the point of the file. Anything dario changes that is
// not on it is a finding, and adding to it should require saying why in the
// same commit.
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as netConnect } from 'node:net';

const home = await mkdtemp(join(tmpdir(), 'dario-passthrough-'));
process.on('exit', () => rmSync(home, { recursive: true, force: true }));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';

const accountsDir = join(home, '.dario', 'accounts');
await mkdir(accountsDir, { recursive: true });
await writeFile(join(accountsDir, 'a-main.json'), JSON.stringify({
  alias: 'a-main',
  accessToken: 'token-a-main',
  refreshToken: 'refresh-a-main',
  expiresAt: Date.now() + 8 * 60 * 60_000,
  scopes: ['user:inference'],
  deviceId: 'device-a-main',
  accountUuid: 'account-a-main',
}));

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${extra !== undefined ? `\n       ${extra}` : ''}`); }
}
function header(n) { console.log(`\n${'='.repeat(70)}\n  ${n}\n${'='.repeat(70)}`); }

const { startProxy } = await import('../dist/proxy.js');

const DIR = join(import.meta.dirname, 'fixtures', 'cc-wire-2.1.239');
const index = JSON.parse(readFileSync(join(DIR, 'index.json'), 'utf8'));
const load = (f) => JSON.parse(readFileSync(join(DIR, f), 'utf8'));
const POSTS = index.captures.filter((c) => c.method === 'POST').map((c) => load(c.file));

// ── what dario is ALLOWED to change on the genuine-CC path ────────────────
//
// Each entry names a mutation and why it exists. A diff that matches none of
// these fails the suite.
const ALLOWED = {
  headers: {
    // dario authenticates as ITS pool account, not as whatever token the client
    // happened to hold. This is the entire point of the proxy.
    authorization: 'the pool account\'s token replaces the client\'s',
    // Rewritten by the HTTP client for the real upstream host.
    host: 'upstream host',
    'content-length': 'recomputed after the body is re-serialized',
    'accept-encoding': 'set by the outbound fetch implementation',
    connection: 'hop-by-hop',
    'x-api-key': 'never forwarded on an OAuth request',
    // dario is a different session from the client's. Substituted, and asserted
    // below to stay consistent with the session_id inside metadata.user_id —
    // CC sends the same value in both, and a proxy that rewrites one but not
    // the other is distinguishable from CC on a field nobody looks at.
    'x-claude-code-session-id': 'dario\'s session, not the client\'s',
  },
  body: {
    // device_id / account_uuid / session_id belong to dario's account, not the
    // client's. Substituted deliberately in buildCCRequest.
    metadata: 'identity is dario\'s account, not the client\'s',
  },
};

/** Rebuild a sendable request from a shape-only fixture. */
function reconstruct(fx) {
  const r = fx.request;
  const body = {};
  const filler = (n) => 'x'.repeat(Math.max(0, n));
  for (const key of r.bodyKeyOrder ?? []) {
    switch (key) {
      case 'model': body.model = r.model; break;
      case 'max_tokens': body.max_tokens = r.max_tokens; break;
      case 'stream': body.stream = r.stream; break;
      case 'thinking': body.thinking = r.thinking; break;
      case 'context_management': body.context_management = r.context_management; break;
      case 'output_config': body.output_config = r.output_config; break;
      case 'metadata': body.metadata = r.metadata; break;
      case 'system':
        body.system = Array.isArray(r.systemBlocks)
          ? r.systemBlocks.map((b) => ({
              type: b.type,
              text: b.text ?? filler(b.chars),
              ...(b.cache_control ? { cache_control: b.cache_control } : {}),
            }))
          : r.systemBlocks;
        break;
      case 'tools':
        body.tools = (r.toolNames ?? []).map((n) => {
          const server = (r.serverTools ?? []).find((s) => s.name === n);
          // A server tool carries a `type` and NO input_schema; reproducing that
          // distinction matters, because a name-keyed tool mapper treats the two
          // identically and server tool names collide with ordinary ones.
          return server ? { ...server } : { name: n, description: `desc ${n}`, input_schema: { type: 'object', properties: {} } };
        });
        break;
      case 'messages':
        body.messages = (r.messages ?? []).map((m) => ({
          role: m.role,
          content: m.blocks
            ? m.blocks.map((b) => (b.type === 'text'
                ? { type: 'text', text: filler(b.chars ?? 4), ...(b.cache_control ? { cache_control: b.cache_control } : {}) }
                : { type: b.type, ...(b.cache_control ? { cache_control: b.cache_control } : {}) }))
            : filler(m.chars ?? 4),
        }));
        break;
      default: body[key] = r[key];
    }
  }
  // Header order as recorded. `host` and `content-length` are rebuilt at send
  // time — their VALUES belong to this connection — but they keep the slots CC
  // put them in, because the point of the exercise is the sequence.
  const headers = [];
  for (const h of r.headerOrder) {
    if (h === 'host' || h === 'content-length') { headers.push([h, null]); continue; }
    if (r.headers[h] !== undefined) headers.push([h, r.headers[h]]);
  }
  return { path: r.path, headers, body };
}

/**
 * Write the request onto a socket byte by byte, in CC's header order.
 *
 * `fetch()` cannot do this job. It owns the header sequence it emits, so a
 * harness that sends through it is asserting the runtime's ordering, not
 * dario's — and the thing under test here is precisely whether dario replays
 * the sequence it was handed. Node's http server preserves what arrives in
 * `rawHeaders`, so a hand-written request is the only way the client's order
 * reaches the code that has to honour it.
 */
function sendRaw(port, sent) {
  const bodyBuf = Buffer.from(JSON.stringify(sent.body));
  const lines = sent.headers.map(([k, v]) => {
    if (k === 'host') return `host: 127.0.0.1:${port}`;
    if (k === 'content-length') return `content-length: ${bodyBuf.length}`;
    return `${k}: ${v}`;
  });
  const head = `POST ${sent.path} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`;
  return new Promise((resolve) => {
    const sock = netConnect(port, '127.0.0.1', () => { sock.write(head); sock.write(bodyBuf); });
    let buf = '';
    const done = () => { try { sock.destroy(); } catch { /* already gone */ } resolve(buf); };
    const timer = setTimeout(done, 8000); timer.unref?.();
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      if (/\r\n0\r\n\r\n$|message_stop/.test(buf)) { clearTimeout(timer); done(); }
    });
    sock.on('error', () => { clearTimeout(timer); done(); });
    sock.on('close', () => { clearTimeout(timer); done(); });
  });
}

/** Send one reconstructed request through dario; return what dario sent on. */
async function throughDario(fx) {
  let seen = null;
  const proxy = await startProxy({
    port: 0, host: '127.0.0.1', noLiveCapture: true,
    fetchImpl: async (url, init) => {
      // dario hands fetch either a plain object or a Headers, and either a
      // string or a Request-shaped first argument depending on the path taken.
      // Normalize both, or the diff silently compares everything against
      // `undefined` and reports a total rewrite that never happened.
      const rawHeaders = init?.headers ?? (url && typeof url === 'object' ? url.headers : undefined);
      const headers = {};
      if (rawHeaders && typeof rawHeaders.forEach === 'function' && !Array.isArray(rawHeaders)) {
        rawHeaders.forEach((v, k) => { headers[String(k).toLowerCase()] = v; });
      } else if (Array.isArray(rawHeaders)) {
        for (const [k, v] of rawHeaders) headers[String(k).toLowerCase()] = v;
      } else {
        for (const [k, v] of Object.entries(rawHeaders ?? {})) headers[String(k).toLowerCase()] = v;
      }
      let rawBody = init?.body;
      if (rawBody == null && url && typeof url === 'object' && typeof url.text === 'function') rawBody = await url.text();
      if (rawBody && typeof rawBody !== 'string') {
        try { rawBody = Buffer.from(await new Response(rawBody).arrayBuffer()).toString('utf8'); } catch { rawBody = String(rawBody); }
      }
      seen = {
        url: String(typeof url === 'object' && url?.url ? url.url : url),
        headers,
        body: (() => { try { return JSON.parse(String(rawBody ?? 'null')); } catch { return null; } })(),
        rawBody: String(rawBody ?? ''),
      };
      return new Response(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n'
        + 'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const sent = reconstruct(fx);
  try {
    await sendRaw(proxy.port, sent);
  } finally {
    await proxy.close?.();
  }
  return { sent, seen: { ...seen, headerOrder: seen ? Object.keys(seen.headers) : [] } };
}

// ======================================================================
header(`the corpus is real CC ${index.ccVersion}`);
{
  check(`${index.captures.length} shapes recorded ${index.recordedAt}`, index.captures.length >= 4);
  check('every POST came from claude-cli, not a synthetic client',
    POSTS.every((p) => /^claude-cli\/[\d.]+ /.test(p.request.headers['user-agent'] ?? '')));
  check(`every POST is ${index.ccVersion}`,
    POSTS.every((p) => p.request.headers['user-agent'].startsWith(`claude-cli/${index.ccVersion} `)));
  // Both entrypoints, or the corpus only describes one client again.
  const eps = new Set(POSTS.map((p) => /\(external, ([^)]+)\)/.exec(p.request.headers['user-agent'])?.[1]));
  check('both the interactive and the SDK entrypoint are represented', eps.has('cli') && eps.has('sdk-cli'), [...eps].join(', '));
  check('no fixture carries a live credential',
    !readdirSync(DIR).some((f) => /sk-ant-(?!REDACTED)/.test(readFileSync(join(DIR, f), 'utf8'))));
}

// ======================================================================
header('dario recognises every real 2.1.239 shape as genuine CC');
{
  const { isGenuineCCClient } = await import('../dist/cc-template.js');
  for (const fx of POSTS) {
    const { headers: pairs, body } = reconstruct(fx);
    const headers = Object.fromEntries(pairs.filter(([, v]) => v !== null));
    // A miss here is the expensive failure: dario would start rewriting a real
    // CC request as if it were a foreign client — remapping tool names,
    // substituting its own system prompt, scrubbing orchestration tags.
    check(`${fx.name}: recognised`, isGenuineCCClient(body, headers) === true);
  }
  // The quota probe is the shape that makes this non-trivial: no system key at
  // all, so the body test alone reads it as foreign and only the headers save it.
  const probe = POSTS.find((p) => p.name === 'quota-probe');
  if (probe) check('the quota probe has no system block at all, and is still recognised',
    probe.request.systemBlocks === null && isGenuineCCClient(
      reconstruct(probe).body,
      Object.fromEntries(reconstruct(probe).headers.filter(([, v]) => v !== null))));
}

// ======================================================================
header('what arrives is what leaves');
for (const fx of POSTS) {
  const { sent, seen } = await throughDario(fx);
  if (!seen) { check(`${fx.name}: reached the upstream`, false, 'fetchImpl never called'); continue; }

  const bodyDiff = [];
  for (const k of new Set([...Object.keys(sent.body), ...Object.keys(seen.body ?? {})])) {
    if (ALLOWED.body[k]) continue;
    if (JSON.stringify(sent.body[k]) !== JSON.stringify(seen.body?.[k])) bodyDiff.push(k);
  }
  check(`${fx.name}: no unlisted body field changed`, bodyDiff.length === 0, bodyDiff.join(', '));

  check(`${fx.name}: top-level key order preserved`,
    JSON.stringify(Object.keys(seen.body ?? {})) === JSON.stringify(Object.keys(sent.body)),
    `sent ${Object.keys(sent.body).join(',')}\n       got  ${Object.keys(seen.body ?? {}).join(',')}`);

  const hdrDiff = [];
  for (const [k, v] of sent.headers) {
    if (v === null || ALLOWED.headers[k]) continue;
    const got = seen.headers[k.toLowerCase()];
    if (got !== v) hdrDiff.push(`${k}: sent ${v} / got ${got}`);
  }
  check(`${fx.name}: no unlisted header changed`, hdrDiff.length === 0, hdrDiff.join('\n       '));

  // Header ORDER, not just header values. It is the cheapest thing about a
  // client to fingerprint and the cheapest to get wrong: nothing in the HTTP
  // spec preserves it, so a proxy that rebuilds a header map from an object
  // emits whatever its own insertion order was. Compared over the headers CC
  // actually sent, in CC's own sequence, ignoring the hop-by-hop ones the
  // outbound client owns.
  //
  // `authorization` is in scope here even though dario replaces its VALUE.
  // Position and value are separate claims, and leaving it out of the order
  // check is what hid the defect this assertion now guards: the template's
  // captured order was recorded with an API key, so it had no `authorization`
  // slot and every genuine request went out with the bearer appended last
  // instead of second. Only the headers a client library genuinely owns —
  // framing and transport — stay excluded.
  const HOP = new Set(['host', 'content-length', 'connection', 'accept-encoding']);
  const wantOrder = fx.request.headerOrder.filter((h) => !HOP.has(h) && seen.headers[h] !== undefined);
  const gotOrder = seen.headerOrder.filter((h) => wantOrder.includes(h));
  check(`${fx.name}: header order preserved (${wantOrder.length} headers)`,
    JSON.stringify(wantOrder) === JSON.stringify(gotOrder),
    `CC   ${wantOrder.join(' ')}\n       got  ${gotOrder.join(' ')}`);

  // Identity substitution is the one body mutation on the allowlist, so assert
  // it actually happened rather than trusting the exemption.
  if (sent.body.metadata) {
    let uid = null;
    try { uid = JSON.parse(seen.body.metadata.user_id); } catch { /* leave null */ }
    check(`${fx.name}: metadata carries dario's account, not the client's`,
      uid?.account_uuid === 'account-a-main' && uid?.device_id === 'device-a-main',
      JSON.stringify(uid));
    // Real CC sends ONE session id, in the header and in metadata. Rewriting
    // one and not the other, or rewriting both to different values, is a
    // mismatch no real client produces.
    check(`${fx.name}: the substituted session id is the same in header and body`,
      seen.headers['x-claude-code-session-id'] === uid?.session_id,
      `header ${seen.headers['x-claude-code-session-id']} / body ${uid?.session_id}`);
  }
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
