#!/usr/bin/env bun
/**
 * Voice dictation WebSocket relay — protocol-level tests against a fake upstream.
 *
 * Claude Code builds the voice WebSocket URL from its OAuth config, not from
 * ANTHROPIC_BASE_URL, so before this relay existed the socket went straight to
 * api.anthropic.com carrying the user's own OAuth token. The relay's whole job
 * is to take that socket over, swap the credential for a pool one, and then get
 * out of the way — so what is worth asserting is the handshake and the bytes,
 * not any WebSocket semantics dario deliberately does not implement.
 *
 * The shapes under test came out of the CC 2.1.237 bundle: the path, the query
 * string and its order, the four identity headers, and `Authorization: Bearer
 * <CC's own OAuth token>` — which is exactly the header that must NOT reach
 * Anthropic.
 *
 * The head-buffer section is the reason this file exists. Bun delivers bytes
 * that arrive in the same packet as the 101 in the `head` argument; Node leaves
 * them on the socket with `head` empty. A relay that ignores `head` passes on
 * Node and silently eats the server's first frame on Bun.
 *
 * No network, no credentials, no `claude` binary: a loopback http server stands
 * in for api.anthropic.com.
 */

import { createServer as createHttpServer } from 'node:http';
import { connect as netConnect } from 'node:net';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Sandboxed HOME before the proxy module loads: homeDir() is what the account
// store reads, and the suite must never touch the operator's real ~/.dario.
const home = await mkdtemp(join(tmpdir(), 'dario-voice-ws-'));
// On 'exit', not after the last assertion: a failing check exits(1) below,
// which is exactly when the stranded dir is most likely.
process.on('exit', () => rmSync(home, { recursive: true, force: true }));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';

// Two seats, so the 401 failover has somewhere to go.
const accountsDir = join(home, '.dario', 'accounts');
await mkdir(accountsDir, { recursive: true });
for (const alias of ['a-main', 'z-backup']) {
  await writeFile(join(accountsDir, `${alias}.json`), JSON.stringify({
    alias,
    accessToken: `token-${alias}`,
    refreshToken: `refresh-${alias}`,
    expiresAt: Date.now() + 8 * 60 * 60_000,  // far enough out that no refresh fires
    scopes: ['user:inference'],
    deviceId: `device-${alias}`,
    accountUuid: `account-${alias}`,
  }));
}

const { startProxy } = await import('../dist/proxy.js');
const {
  isVoiceUpgradePath, buildUpstreamHeaders, VOICE_WS_PATH, FORWARDED_UPGRADE_HEADERS,
} = await import('../dist/voice-relay.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' :: ' + detail : ''}`); }
}
function header(n) { console.log(`\n${'='.repeat(70)}\n  ${n}\n${'='.repeat(70)}`); }

/** The query string CC 2.1.236/2.1.237 builds, in the order URLSearchParams emits it. */
const CC_QUERY = 'encoding=linear16&sample_rate=16000&channels=1&endpointing_ms=300'
  + '&utterance_end_ms=1000&language=en&use_conversation_engine=true&stt_provider=deepgram-nova3';

/** The upgrade request CC sends, as raw bytes. `extra` is appended after the blank line. */
function ccUpgradeRequest({ path = `${VOICE_WS_PATH}?${CC_QUERY}`, auth = 'Bearer cc-own-oauth-token', extra = '' } = {}) {
  return 'GET ' + path + ' HTTP/1.1\r\n'
    + 'Host: 127.0.0.1\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
    + 'Sec-WebSocket-Version: 13\r\n'
    + `Authorization: ${auth}\r\n`
    + 'User-Agent: claude-cli/2.1.236 (external, cli)\r\n'
    + 'x-app: cli\r\n'
    + 'anthropic-client-platform: claude_code_cli\r\n'
    + 'x-config-keyterms: dario,BoringSSL\r\n'
    + '\r\n' + extra;
}

/**
 * Fake upstream standing in for api.anthropic.com.
 *   opts.status        — answer this instead of upgrading (401, 429, …)
 *   opts.firstFrame    — bytes to send after the 101
 *   opts.coalesce      — write the 101 and firstFrame in ONE write, which is
 *                        what puts them in the client's `head` buffer on Bun
 *   opts.failFirstAuth — 401 the first request, upgrade the second
 */
function startFakeUpstream(opts = {}) {
  const seen = [];
  const sockets = new Set();
  let requests = 0;
  let upstreamFins = 0;
  const server = createHttpServer((req, res) => { res.writeHead(404); res.end('not the upgrade path\n'); });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.on('upgrade', (req, socket, head) => {
    requests++;
    seen.push({ url: req.url, headers: { ...req.headers }, head: Buffer.from(head ?? []) });
    socket.on('error', () => {});
    const refuseWith = opts.failFirstAuth && requests === 1 ? 401 : opts.status;
    if (refuseWith) {
      socket.end(`HTTP/1.1 ${refuseWith} Refused\r\nrequest-id: req_fake_123\r\nretry-after: 7\r\n`
        + 'x-secret-upstream-header: must-not-leak\r\nConnection: close\r\n\r\n');
      return;
    }
    const status = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + 'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n';
    if (opts.coalesce && opts.firstFrame) {
      socket.write(Buffer.concat([Buffer.from(status), opts.firstFrame]));
    } else {
      socket.write(status);
      if (opts.firstFrame) socket.write(opts.firstFrame);
    }
    // Echo whatever the client sends, so the client→upstream direction is observable.
    socket.on('data', (d) => { if (!socket.destroyed) socket.write(d); });
    // Watch for the FIN, which is how "dario released this connection" is
    // observable from here. Deliberately NOT 'close': a socket detached by
    // server.on('upgrade') never emits 'close' on a graceful peer shutdown, on
    // Bun or on Node. An earlier version of this file counted 'close' and
    // reported a shutdown leak that did not exist — `ss -tn` showed the
    // established count going 2 → 0 on the same teardown the assertion called
    // a leak. 'end' fires on both runtimes and tracks the connection.
    socket.on('end', () => { upstreamFins++; });
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({
    port: server.address().port,
    seen,
    get requests() { return requests; },
    // How many relayed upstream connections have been shut down by dario.
    // See the 'end' handler above for why this is not a socket count.
    get upstreamFins() { return upstreamFins; },
    close: () => new Promise((done) => { for (const s of sockets) s.destroy(); server.close(() => done()); }),
  })));
}

/** Start dario pointed at a fake upstream, with a one-account pool. */
async function startDario(upstreamPort, extra = {}) {
  return startProxy({
    port: 0,
    host: '127.0.0.1',
    voiceUpstream: { host: '127.0.0.1', port: upstreamPort, tls: false },
    noLiveCapture: true,
    // Nothing in this file sends an inference request; the fetch is stubbed
    // only so a stray background call cannot reach the network.
    fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    ...extra,
  });
}

/**
 * Speak raw bytes at dario and collect everything that comes back.
 * Resolves once `until` is satisfied over the accumulated buffer, or on close.
 */
function rawExchange(port, payload, { until = (b) => b.includes('\r\n\r\n'), afterHandshake, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let sentFollowUp = false;
    let done = false;
    const sock = netConnect(port, '127.0.0.1', () => sock.write(payload));
    // Resolve on timeout rather than reject. Every failure mode here is
    // "expected bytes never arrived", and that has to surface as a red check
    // with the partial buffer quoted, not as an unhandled rejection that
    // abandons the remaining sections and prints no tally. Verified by
    // mutation: disabling the upstream-head write turns the coalesced-frame
    // check red instead of taking the file down.
    const finish = () => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve({ buf, sock, timedOut: !until(buf) }); };
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (afterHandshake && !sentFollowUp && buf.includes('\r\n\r\n')) {
        sentFollowUp = true;
        sock.write(afterHandshake);
      }
      if (until(buf)) finish();
    });
    sock.on('error', finish);
    sock.on('close', finish);
    setTimeout(finish, timeoutMs).unref?.();
  });
}

const statusLine = (buf) => buf.toString('binary').split('\r\n')[0];
const bodyAfterHeaders = (buf) => buf.subarray(buf.indexOf('\r\n\r\n') + 4);

// ---------------------------------------------------------------------------
header('Pure helpers');

check('the voice path matches with a query string', isVoiceUpgradePath(`${VOICE_WS_PATH}?${CC_QUERY}`));
check('the voice path matches bare', isVoiceUpgradePath(VOICE_WS_PATH));
check('a different path does not match', !isVoiceUpgradePath('/v1/messages'));
check('an undefined url does not match', !isVoiceUpgradePath(undefined));
// The relay never resolves a path segment, so a traversal cannot walk into the
// allowlist. Assert the literal comparison rather than trusting a normalizer.
check('a traversal into the voice path does not match',
  !isVoiceUpgradePath(`${VOICE_WS_PATH}/../../v1/messages`));
check('a percent-encoded traversal does not match',
  !isVoiceUpgradePath(`${VOICE_WS_PATH}%2f..%2f..%2fv1%2fmessages`));
check('a prefix of the voice path does not match', !isVoiceUpgradePath('/api/ws/speech_to_text'));

{
  const built = buildUpstreamHeaders({
    authorization: 'Bearer cc-own-oauth-token',
    'user-agent': 'claude-cli/2.1.236 (external, cli)',
    'x-app': 'cli',
    'anthropic-client-platform': 'claude_code_cli',
    'x-config-keyterms': 'dario',
    'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    'x-api-key': 'the-dario-key',
    cookie: 'session=secret',
  }, 'pool-token', 'api.anthropic.com');
  check('Authorization is replaced with the pool token', built.authorization === 'Bearer pool-token');
  check("the client's own bearer is gone", !JSON.stringify(built).includes('cc-own-oauth-token'));
  check('x-api-key is not forwarded', built['x-api-key'] === undefined);
  check('cookie is not forwarded', built.cookie === undefined);
  check('the four CC identity headers survive',
    built['user-agent'] === 'claude-cli/2.1.236 (external, cli)' && built['x-app'] === 'cli'
    && built['anthropic-client-platform'] === 'claude_code_cli' && built['x-config-keyterms'] === 'dario');
  check('the handshake key survives', built['sec-websocket-key'] === 'dGhlIHNhbXBsZSBub25jZQ==');
  check('host is the upstream host', built.host === 'api.anthropic.com');
  check('the forward list is an allowlist, not a denylist',
    !FORWARDED_UPGRADE_HEADERS.includes('authorization'));
}

// ---------------------------------------------------------------------------
header('The upgrade relays, and the credential is swapped');
{
  const upstream = await startFakeUpstream({ firstFrame: Buffer.from([0x81, 0x02, 0x68, 0x69]) });
  const dario = await startDario(upstream.port);
  try {
    const { buf } = await rawExchange(dario.port, ccUpgradeRequest(),
      { until: (b) => b.includes('\r\n\r\n') && bodyAfterHeaders(b).length >= 4 });

    check('the client gets 101', statusLine(buf) === 'HTTP/1.1 101 Switching Protocols', statusLine(buf));
    // The relay must own the socket from the first byte. An upgrade request is
    // routed to the 'upgrade' event and never reaches the request handler on
    // either runtime, so nothing on the ordinary response path — the allowlist
    // 404, sendError's envelope, the streaming error terminator — can have
    // written ahead of the 101. Assert it rather than trust it: this is the
    // one ordering the whole relay rests on.
    check('nothing on the HTTP response path wrote to the socket first',
      !buf.toString('binary').includes('not_found_error')
      && !buf.toString('binary').includes('event: error')
      && buf.indexOf('HTTP/1.1 101') === 0);
    check('Sec-WebSocket-Accept is relayed',
      buf.toString('binary').includes('Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo='));

    const req = upstream.seen[0];
    check('the upstream saw exactly one upgrade', upstream.seen.length === 1);
    check('the query string arrives byte-identical, order intact',
      req.url === `${VOICE_WS_PATH}?${CC_QUERY}`, req.url);
    check('Authorization was replaced, not forwarded',
      req.headers.authorization !== 'Bearer cc-own-oauth-token'
      && /^Bearer .+/.test(req.headers.authorization ?? ''), req.headers.authorization);
    check('the CC identity headers reached the upstream verbatim',
      req.headers['user-agent'] === 'claude-cli/2.1.236 (external, cli)'
      && req.headers['x-app'] === 'cli'
      && req.headers['anthropic-client-platform'] === 'claude_code_cli'
      && req.headers['x-config-keyterms'] === 'dario,BoringSSL');
    check('the handshake key reached the upstream unchanged',
      req.headers['sec-websocket-key'] === 'dGhlIHNhbXBsZSBub25jZQ==');
    check("the upstream's first frame reached the client",
      bodyAfterHeaders(buf).subarray(0, 4).toString('hex') === '81026869',
      bodyAfterHeaders(buf).toString('hex'));
  } finally {
    await dario.close(); await upstream.close();
  }
}

// ---------------------------------------------------------------------------
header('The head buffer — the bug that only shows on Bun');
{
  // The 101 and the first frame leave the upstream in ONE write, so they land
  // in the same TCP segment. On Bun those trailing bytes are handed to the
  // relay in the client-request's `head` argument and never appear as 'data';
  // on Node `head` is empty and they arrive later. A relay that forwards only
  // the stream silently drops the frame on Bun.
  const frame = Buffer.from([0x81, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]); // "hello"
  const upstream = await startFakeUpstream({ firstFrame: frame, coalesce: true });
  const dario = await startDario(upstream.port);
  try {
    const { buf } = await rawExchange(dario.port, ccUpgradeRequest(),
      { until: (b) => b.includes('\r\n\r\n') && bodyAfterHeaders(b).length >= frame.length });
    check('101 still relays when it is coalesced with the first frame',
      statusLine(buf) === 'HTTP/1.1 101 Switching Protocols', statusLine(buf));
    check('the coalesced first frame is not swallowed',
      bodyAfterHeaders(buf).subarray(0, frame.length).equals(frame),
      `got ${bodyAfterHeaders(buf).toString('hex')}, want ${frame.toString('hex')}`);
  } finally {
    await dario.close(); await upstream.close();
  }
}
{
  // Mirror image: the client sends its first audio frame in the same packet as
  // the upgrade request, so it lands in the SERVER-side `head` buffer. Both
  // runtimes populate that one, but forgetting to write it loses the first
  // chunk of audio on every platform.
  const early = Buffer.from([0x82, 0x04, 0xde, 0xad, 0xbe, 0xef]);
  const upstream = await startFakeUpstream();
  const dario = await startDario(upstream.port);
  try {
    await rawExchange(dario.port, Buffer.concat([Buffer.from(ccUpgradeRequest()), early]),
      { until: (b) => b.includes('\r\n\r\n') && bodyAfterHeaders(b).length >= early.length });
    // The fake echoes, so seeing it come back proves it reached the upstream.
    check('early client bytes reach the upstream', upstream.seen.length === 1);
  } finally {
    await dario.close(); await upstream.close();
  }
}

// ---------------------------------------------------------------------------
header('Bytes move both ways, unparsed');
{
  const upstream = await startFakeUpstream();
  const dario = await startDario(upstream.port);
  try {
    // 4 KiB of binary audio, including bytes a frame parser would choke on.
    const audio = Buffer.alloc(4096);
    for (let i = 0; i < audio.length; i++) audio[i] = (i * 31) & 0xff;
    const { buf } = await rawExchange(dario.port, ccUpgradeRequest(), {
      afterHandshake: audio,
      until: (b) => b.includes('\r\n\r\n') && bodyAfterHeaders(b).length >= audio.length,
      timeoutMs: 10000,
    });
    check('a 4 KiB binary payload round-trips unmodified',
      bodyAfterHeaders(buf).subarray(0, audio.length).equals(audio));
  } finally {
    await dario.close(); await upstream.close();
  }
}

// ---------------------------------------------------------------------------
header('Refusals');
{
  const upstream = await startFakeUpstream();
  const dario = await startDario(upstream.port);
  try {
    const { buf } = await rawExchange(dario.port, ccUpgradeRequest({ path: '/api/ws/anything-else' }));
    check('a non-allowlisted upgrade path answers 404, matching the HTTP allowlist',
      statusLine(buf) === 'HTTP/1.1 404 Not Found', statusLine(buf));
    check('a refused path never dials the upstream', upstream.seen.length === 0);

    const t = await rawExchange(dario.port, ccUpgradeRequest({ path: `${VOICE_WS_PATH}/../../v1/messages` }));
    check('a traversal past the voice path is refused', statusLine(t.buf) === 'HTTP/1.1 404 Not Found', statusLine(t.buf));
    check('the traversal never dialled the upstream', upstream.seen.length === 0);
  } finally {
    await dario.close(); await upstream.close();
  }
}
{
  // A plain GET to the voice path carries no Upgrade header, so it is an
  // ordinary request and must still get the allowlist's 404 — there is nothing
  // to relay without a handshake.
  const upstream = await startFakeUpstream();
  const dario = await startDario(upstream.port);
  try {
    const res = await fetch(`http://127.0.0.1:${dario.port}${VOICE_WS_PATH}?${CC_QUERY}`);
    const body = await res.json();
    check('a non-upgrade GET to the voice path answers 404', res.status === 404, String(res.status));
    check('and it answers with the API error envelope',
      body?.error?.type === 'not_found_error', JSON.stringify(body));
    check('a non-upgrade GET never dials the upstream', upstream.seen.length === 0);
  } finally {
    await dario.close(); await upstream.close();
  }
}
{
  const upstream = await startFakeUpstream({ status: 429 });
  const dario = await startDario(upstream.port);
  try {
    const { buf } = await rawExchange(dario.port, ccUpgradeRequest());
    // CC reads the status off `ws`'s unexpected-response event and classifies
    // 4xx as fatal, so relaying the real status is what lets it say something
    // true to the user.
    check('an upstream refusal is relayed with its status', statusLine(buf).startsWith('HTTP/1.1 429'), statusLine(buf));
    check('request-id is relayed', buf.toString('binary').includes('request-id: req_fake_123'));
    check('retry-after is relayed', buf.toString('binary').includes('retry-after: 7'));
    check('other upstream headers are not relayed',
      !buf.toString('binary').includes('must-not-leak'));
  } finally {
    await dario.close(); await upstream.close();
  }
}
{
  // A stale pool token 401s. CC treats that as fatal and gives the user no
  // retry, so the failover has to happen here or not at all.
  const upstream = await startFakeUpstream({ failFirstAuth: true });
  const dario = await startDario(upstream.port);
  try {
    const { buf } = await rawExchange(dario.port, ccUpgradeRequest(),
      { until: (b) => b.includes('\r\n\r\n') });
    check('a 401 on the first account is retried, not relayed',
      statusLine(buf) === 'HTTP/1.1 101 Switching Protocols' || upstream.requests === 2,
      `status=${statusLine(buf)} upstreamRequests=${upstream.requests}`);
  } finally {
    await dario.close(); await upstream.close();
  }
}
{
  const upstream = await startFakeUpstream();
  const dario = await startDario(upstream.port, { egressProxyConfigured: true });
  try {
    const { buf } = await rawExchange(dario.port, ccUpgradeRequest());
    // Declining is the point: node:https does not go through the fetch wrapper
    // that implements --egress-proxy, so relaying would send this one socket
    // direct while everything else tunnelled.
    check('the relay declines while --egress-proxy is set',
      statusLine(buf) === 'HTTP/1.1 502 Bad Gateway', statusLine(buf));
    check('and it never dials the upstream', upstream.seen.length === 0);
  } finally {
    await dario.close(); await upstream.close();
  }
}

// ---------------------------------------------------------------------------
header('Teardown');
{
  const upstream = await startFakeUpstream();
  const dario = await startDario(upstream.port);

  // Hold the relay OPEN across close(). Destroying the client first would make
  // this vacuous — teardown() would already have reaped the upstream half, and
  // close() would resolve whether or not it tracks its sockets. Verified by
  // mutation: with the client destroyed, removing destroyAll() from close()
  // still passed; holding it open turns that mutation red.
  const live = await new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const s = netConnect(dario.port, '127.0.0.1', () => s.write(ccUpgradeRequest()));
    s.on('error', () => {});
    s.on('data', (d) => { buf = Buffer.concat([buf, d]); if (buf.includes('\r\n\r\n')) resolve(s); });
    setTimeout(() => resolve(s), 5000).unref?.();
  });

  // An upgraded socket is detached from the http server: server.close() does
  // not reach it, and closeAllConnections() does not either. On Bun the
  // observable symptom is not a hang but a leak — close() resolves happily and
  // the socket, and the upstream TLS session behind it, stay open past the
  // proxy that owned them. Hence two assertions: close() returns, AND the
  // socket is actually gone.
  // dario destroys its own half; the client learns about it on the next turn
  // of the event loop, so watch for the event rather than reading a flag.
  const clientSawClose = new Promise((r) => {
    live.once('close', () => r('closed'));
    setTimeout(() => r('still open'), 5000).unref?.();
  });
  const closed = await Promise.race([
    dario.close().then(() => 'closed'),
    new Promise((r) => setTimeout(() => r('hung'), 5000)),
  ]);
  check('close() resolves with a relay socket still open', closed === 'closed', String(closed));
  check('and the relay socket is torn down, not left dangling',
    (await clientSawClose) === 'closed');
  // The client half going away is only half of it. The upstream half is the
  // expensive one — a live TLS session to api.anthropic.com holding a pool
  // token, outliving the proxy that opened it. Give the FIN a turn to land.
  await new Promise((r) => setTimeout(r, 250));
  check('and the upstream connection is released too', upstream.upstreamFins === 1,
    `${upstream.upstreamFins} FIN(s) seen upstream`);
  live.destroy();
  await upstream.close();
}

console.log(`\n${'='.repeat(70)}\n  ${pass} pass, ${fail} fail\n${'='.repeat(70)}`);
process.exit(fail === 0 ? 0 : 1);
