#!/usr/bin/env bun
// SOCKS5 bridge — protocol-level tests against a fake SOCKS5 server.
//
// The parser tests in outbound-proxy.mjs cover URL shapes; this covers
// the bytes on the wire, which is where a hand-rolled SOCKS client
// actually goes wrong: greeting/method negotiation, RFC 1929 auth, the
// CONNECT address encoding (domain vs IPv4 — the socks5h/socks5 split),
// error replies, and the CONNECT-only contract the bridge exposes to
// Bun's fetch.
//
// No network access: a loopback echo server stands in for the origin and
// a loopback fake proxy stands in for the SOCKS5 service.

import { createServer as createNetServer, connect as netConnect } from 'node:net';
import { startSocks5Bridge } from '../dist/socks5-bridge.js';
import { installEgressProxy, parseOutboundProxy } from '../dist/outbound-proxy.js';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' :: ' + detail : ''}`); }
}
function header(n) { console.log(`\n${'='.repeat(70)}\n  ${n}\n${'='.repeat(70)}`); }

// Fixtures get torn down, not drained. server.close() waits on every
// accepted socket, so one straggler wedges the whole file after the last
// assertion has already passed — a hang with a green transcript. Track
// what we accept and destroy it; net.Server has no closeAllConnections()
// (that one is http.Server-only, in Bun and Node alike).
const accepted = new WeakMap();
const listen = (server, port = 0) => {
  const socks = new Set();
  accepted.set(server, socks);
  server.on('connection', (s) => { socks.add(s); s.on('close', () => socks.delete(s)); });
  return new Promise((res) => server.listen(port, '127.0.0.1', () => res(server.address().port)));
};
const close = (server) => new Promise((res) => {
  for (const s of accepted.get(server) ?? []) s.destroy();
  server.close(() => res());
});

/** Echo server standing in for the origin behind the proxy. */
function startEcho(greeting) {
  const server = createNetServer((sock) => {
    // An origin that speaks first is how a wrong reply-drain length shows
    // up: the leftover bytes of the SOCKS reply get forwarded into the
    // tunnel ahead of it, or the greeting's first bytes get eaten.
    if (greeting) sock.write(greeting);
    sock.pipe(sock);
  });
  return listen(server).then((port) => ({ port, close: () => close(server) }));
}

/**
 * Minimal fake SOCKS5 server.
 *   opts.requireAuth  — demand RFC 1929 username/password
 *   opts.credentials  — { username, password } the fake will accept
 *   opts.failWith     — reply code to return instead of success (0x00)
 *   opts.forwardPort  — loopback port to splice the client to on success
 *   opts.replyAtyp    — address type in the success reply (0x01 default)
 *   opts.dribble      — write every reply one byte at a time, so a reader
 *                       that assumes frame-aligned `data` events breaks
 * Records the decoded CONNECT target on `.lastTarget`.
 */
function startFakeSocks5(opts = {}) {
  const state = { lastTarget: null, authAttempt: null };
  // TCP is free to chunk however it likes, and a real proxy across a real
  // network routinely splits a handshake frame. Writing byte-at-a-time is
  // the cheap way to make that deterministic instead of load-dependent.
  const emit = (sock, bytes) => {
    if (!opts.dribble) { sock.write(bytes); return; }
    for (const b of bytes) sock.write(Buffer.from([b]));
  };
  const server = createNetServer((sock) => {
    let phase = 'greeting';
    let buf = Buffer.alloc(0);

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      if (phase === 'greeting') {
        if (buf.length < 2) return;
        const nmethods = buf[1];
        if (buf.length < 2 + nmethods) return;
        const methods = [...buf.subarray(2, 2 + nmethods)];
        buf = buf.subarray(2 + nmethods);
        if (opts.requireAuth) {
          if (!methods.includes(0x02)) { sock.end(Buffer.from([0x05, 0xff])); return; }
          emit(sock, Buffer.from([0x05, 0x02]));
          phase = 'auth';
        } else {
          emit(sock, Buffer.from([0x05, 0x00]));
          phase = 'request';
        }
      }

      if (phase === 'auth') {
        if (buf.length < 2) return;
        const ulen = buf[1];
        if (buf.length < 2 + ulen + 1) return;
        const plen = buf[2 + ulen];
        if (buf.length < 3 + ulen + plen) return;
        const username = buf.subarray(2, 2 + ulen).toString();
        const password = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
        buf = buf.subarray(3 + ulen + plen);
        state.authAttempt = { username, password };
        const ok = username === opts.credentials?.username && password === opts.credentials?.password;
        emit(sock, Buffer.from([0x01, ok ? 0x00 : 0x01]));
        if (!ok) { sock.end(); return; }
        phase = 'request';
      }

      if (phase === 'request') {
        if (buf.length < 5) return;
        const atyp = buf[3];
        let host, consumed;
        if (atyp === 0x01) {
          if (buf.length < 10) return;
          host = [...buf.subarray(4, 8)].join('.');
          consumed = 10;
        } else if (atyp === 0x03) {
          const len = buf[4];
          if (buf.length < 5 + len + 2) return;
          host = buf.subarray(5, 5 + len).toString();
          consumed = 5 + len + 2;
        } else if (atyp === 0x04) {
          if (buf.length < 22) return;
          const parts = [];
          for (let i = 0; i < 8; i++) parts.push(buf.readUInt16BE(4 + i * 2).toString(16));
          host = parts.join(':');
          consumed = 22;
        } else {
          sock.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          return;
        }
        const port = buf.readUInt16BE(consumed - 2);
        buf = buf.subarray(consumed);
        state.lastTarget = { atyp, host, port };

        if (opts.failWith !== undefined) {
          sock.end(Buffer.from([0x05, opts.failWith, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          return;
        }

        // Success reply, then splice to the stand-in origin. RFC 1928 lets
        // the bound address come back in any of the three forms, and the
        // client has to drain exactly the right number of bytes for it —
        // over-draining eats the origin's first bytes, under-draining
        // injects address bytes into the TLS stream. Both corrupt the
        // session silently, so the fake can reply in all three shapes.
        const atypOut = opts.replyAtyp ?? 0x01;
        let reply;
        if (atypOut === 0x03) {
          const name = Buffer.from('proxy-bound.example');
          reply = Buffer.concat([Buffer.from([0x05, 0x00, 0x00, 0x03, name.length]), name, Buffer.from([0x1f, 0x90])]);
        } else if (atypOut === 0x04) {
          const v6 = Buffer.alloc(16); v6[15] = 1;
          reply = Buffer.concat([Buffer.from([0x05, 0x00, 0x00, 0x04]), v6, Buffer.from([0x1f, 0x90])]);
        } else {
          reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x1f, 0x90]);
        }
        emit(sock, reply);
        const upstream = netConnect({ host: '127.0.0.1', port: opts.forwardPort }, () => {
          if (buf.length) upstream.write(buf);
          sock.pipe(upstream);
          upstream.pipe(sock);
        });
        upstream.on('error', () => sock.destroy());
        // Real proxies drop both halves together. Without this the origin
        // side survives the client going away, and the stand-in server's
        // close() never resolves — the suite passes every assertion and
        // then hangs on teardown.
        sock.on('close', () => upstream.destroy());
        phase = 'tunnel';
      }
    });
    sock.on('error', () => {});
  });
  return listen(server).then((port) => ({ port, state, server, close: () => close(server) }));
}


/**
 * The bridge issues a per-process token so no other local process can
 * relay through the operator's SOCKS5 proxy. Tests speak it like Bun's
 * fetch does: Basic auth in the CONNECT request.
 */
let TOKEN_AUTH = null;
function useBridge(bridge) {
  const u = new URL(bridge.proxyUrl);
  TOKEN_AUTH = 'Basic ' + Buffer.from(`${u.username}:${decodeURIComponent(u.password)}`).toString('base64');
  return bridge;
}

/**
 * Speak HTTP CONNECT to the bridge; resolve with status line + tunnel
 * socket. `auth` defaults to the bridge's own token — omit it (pass null)
 * to exercise the 407 path.
 */
function connectThroughBridge(bridgePort, target, auth = TOKEN_AUTH) {
  return new Promise((resolve, reject) => {
    const sock = netConnect({ host: '127.0.0.1', port: bridgePort }, () => {
      sock.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n`
        + (auth ? `Proxy-Authorization: ${auth}\r\n` : '')
        + '\r\n',
      );
    });
    let head = '';
    const onData = (d) => {
      head += d.toString();
      const idx = head.indexOf('\r\n\r\n');
      if (idx === -1) return;
      sock.removeListener('data', onData);
      const rest = Buffer.from(head.slice(idx + 4));
      resolve({ status: head.slice(0, head.indexOf('\r\n')), sock, rest });
    };
    sock.on('data', onData);
    sock.on('error', reject);
    setTimeout(() => reject(new Error('bridge CONNECT timed out')), 5000).unref?.();
  });
}

const roundTrip = (sock, payload) => new Promise((resolve, reject) => {
  let out = '';
  sock.on('data', (d) => { out += d.toString(); if (out.length >= payload.length) resolve(out); });
  sock.on('error', reject);
  sock.write(payload);
  setTimeout(() => reject(new Error('echo timed out')), 5000).unref?.();
});

// ======================================================================
header('socks5h — remote DNS sends the hostname, tunnel carries bytes');
{
  const echo = await startEcho();
  const proxy = await startFakeSocks5({ forwardPort: echo.port });
  const bridge = useBridge(await startSocks5Bridge({ host: '127.0.0.1', port: proxy.port, remoteDns: true }));

  check('bridge binds loopback only', bridge.url.startsWith('http://127.0.0.1:'));

  const { status, sock } = await connectThroughBridge(bridge.port, 'api.anthropic.com:443');
  check('CONNECT returns 200', status.includes('200'));
  check('proxy saw a domain-name target (atyp 3)', proxy.state.lastTarget?.atyp === 0x03);
  check('hostname sent verbatim — no local DNS leak', proxy.state.lastTarget?.host === 'api.anthropic.com');
  check('port forwarded', proxy.state.lastTarget?.port === 443);

  const echoed = await roundTrip(sock, 'ping-through-socks');
  check('bytes round-trip through the tunnel', echoed === 'ping-through-socks');

  sock.destroy();
  await bridge.close(); await proxy.close(); await echo.close();
}

// ======================================================================
header('socks5 — local DNS resolves before the request');
{
  const echo = await startEcho();
  const proxy = await startFakeSocks5({ forwardPort: echo.port });
  const bridge = useBridge(await startSocks5Bridge({ host: '127.0.0.1', port: proxy.port, remoteDns: false }));

  const { status, sock } = await connectThroughBridge(bridge.port, 'localhost:443');
  check('CONNECT returns 200', status.includes('200'));
  check('proxy saw an address literal, not a name', proxy.state.lastTarget?.atyp !== 0x03);
  check('resolved to loopback', proxy.state.lastTarget?.host === '127.0.0.1' || proxy.state.lastTarget?.host?.endsWith(':1'));

  sock.destroy();
  await bridge.close(); await proxy.close(); await echo.close();
}

// ======================================================================
header('socks5h — an IP destination skips DNS entirely');
{
  const echo = await startEcho();
  const proxy = await startFakeSocks5({ forwardPort: echo.port });
  const bridge = useBridge(await startSocks5Bridge({ host: '127.0.0.1', port: proxy.port, remoteDns: true }));

  const { sock } = await connectThroughBridge(bridge.port, '203.0.113.7:8443');
  check('IPv4 destination sent as atyp 1', proxy.state.lastTarget?.atyp === 0x01);
  check('IPv4 preserved', proxy.state.lastTarget?.host === '203.0.113.7');

  sock.destroy();
  await bridge.close(); await proxy.close(); await echo.close();
}

// ======================================================================
header('RFC 1929 username/password authentication');
{
  const echo = await startEcho();
  const proxy = await startFakeSocks5({
    forwardPort: echo.port, requireAuth: true,
    credentials: { username: 'alice', password: 's@cret' },
  });
  const bridge = useBridge(await startSocks5Bridge({
    host: '127.0.0.1', port: proxy.port, remoteDns: true,
    username: 'alice', password: 's@cret',
  }));

  const { status, sock } = await connectThroughBridge(bridge.port, 'api.anthropic.com:443');
  check('authenticated CONNECT returns 200', status.includes('200'));
  check('username sent on the wire', proxy.state.authAttempt?.username === 'alice');
  check('password sent on the wire', proxy.state.authAttempt?.password === 's@cret');

  sock.destroy();
  await bridge.close(); await proxy.close(); await echo.close();
}

// ======================================================================
header('auth failures and refusals surface as 502, not a hang');
{
  const echo = await startEcho();

  const badCreds = await startFakeSocks5({
    forwardPort: echo.port, requireAuth: true,
    credentials: { username: 'alice', password: 'right' },
  });
  const b1 = useBridge(await startSocks5Bridge({
    host: '127.0.0.1', port: badCreds.port, remoteDns: true,
    username: 'alice', password: 'wrong',
  }));
  const r1 = await connectThroughBridge(b1.port, 'api.anthropic.com:443');
  check('wrong password → 502', r1.status.includes('502'));
  check('502 body explains the rejection', r1.rest.toString().includes('rejected the supplied username/password'));
  check('502 body leaks no password', !r1.rest.toString().includes('wrong'));
  r1.sock.destroy(); await b1.close(); await badCreds.close();

  // Proxy demands auth, dario has no credentials configured.
  const needsAuth = await startFakeSocks5({ forwardPort: echo.port, requireAuth: true, credentials: {} });
  const b2 = useBridge(await startSocks5Bridge({ host: '127.0.0.1', port: needsAuth.port, remoteDns: true }));
  const r2 = await connectThroughBridge(b2.port, 'api.anthropic.com:443');
  check('missing credentials → 502', r2.status.includes('502'));
  check('502 tells the user to add credentials', r2.rest.toString().includes('socks5h://user:pass@'));
  r2.sock.destroy(); await b2.close(); await needsAuth.close();

  // Upstream refuses the CONNECT (reply 0x05, connection refused).
  const refuses = await startFakeSocks5({ forwardPort: echo.port, failWith: 0x05 });
  const b3 = useBridge(await startSocks5Bridge({ host: '127.0.0.1', port: refuses.port, remoteDns: true }));
  const r3 = await connectThroughBridge(b3.port, 'api.anthropic.com:443');
  check('refused CONNECT → 502', r3.status.includes('502'));
  check('502 names the SOCKS reply code', r3.rest.toString().includes('connection refused'));
  r3.sock.destroy(); await b3.close(); await refuses.close();

  await echo.close();
}

// ======================================================================
header('bridge contract — CONNECT only, loopback only');
{
  const echo = await startEcho();
  const proxy = await startFakeSocks5({ forwardPort: echo.port });
  const bridge = useBridge(await startSocks5Bridge({ host: '127.0.0.1', port: proxy.port, remoteDns: true }));

  // Absolute-form GET (what a plain-HTTP proxy request looks like — an
  // OpenAI-compat backend registered with an http:// base-url).
  const res = await fetch(`${bridge.url}/`, {
    method: 'GET', headers: { 'proxy-authorization': TOKEN_AUTH },
  }).catch((e) => e);
  check('non-CONNECT request is answered 501', res?.status === 501);
  const body501 = await res.text?.().catch(() => '') ?? '';
  check('501 names the misconfiguration, not just the verb', /https:/.test(body501), body501.slice(0, 80));

  // The 501 is behind the same token: an unauthenticated caller must not
  // be able to confirm what is listening on the port.
  const probe = await fetch(`${bridge.url}/`, { method: 'GET' }).catch((e) => e);
  check('unauthenticated non-CONNECT is 407, not 501', probe?.status === 407, String(probe?.status));

  // A malformed CONNECT target must not reach the SOCKS layer.
  const bad = await connectThroughBridge(bridge.port, 'no-port-here');
  check('CONNECT without a port → 400', bad.status.includes('400'));
  bad.sock.destroy();

  // Loopback is not private: without a credential every other process
  // and user on the box could relay through the operator's SOCKS5 proxy,
  // which is metered, paid, and identity-bearing.
  const noAuth = await connectThroughBridge(bridge.port, 'api.anthropic.com:443', null);
  check('CONNECT without the token → 407', noAuth.status.includes('407'), noAuth.status);
  noAuth.sock.destroy();

  const wrongAuth = await connectThroughBridge(
    bridge.port, 'api.anthropic.com:443',
    'Basic ' + Buffer.from('dario:wrong-token').toString('base64'),
  );
  check('CONNECT with a wrong token → 407', wrongAuth.status.includes('407'), wrongAuth.status);
  wrongAuth.sock.destroy();

  // A wrong token of the RIGHT length must not slip through a sloppy
  // comparison, and must not throw inside timingSafeEqual either.
  const rightLength = TOKEN_AUTH.slice(0, -4) + (TOKEN_AUTH.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  const sameLen = await connectThroughBridge(bridge.port, 'api.anthropic.com:443', rightLength);
  check('same-length wrong token → 407', sameLen.status.includes('407'), sameLen.status);
  sameLen.sock.destroy();

  check('the loggable url carries no token', !bridge.url.includes('@') && !bridge.url.includes('dario:'));
  check('the proxy url carries the token', /^http:\/\/dario:[^@]+@127\.0\.0\.1:\d+$/.test(bridge.proxyUrl), bridge.proxyUrl);

  await bridge.close(); await proxy.close(); await echo.close();
}

// ======================================================================
// The two things this module exists to get right, and the two that fail
// silently rather than loudly: frame-splitting on the handshake, and the
// length of the bound-address drain in the success reply. Both produce a
// tunnel that connects fine and then corrupts the first bytes of the TLS
// session — which surfaces as an inscrutable handshake failure against a
// real proxy and never on a localhost fixture that writes whole frames.
header('handshake framing — split frames and every reply address type');
{
  const SENTINEL = 'ORIGIN-SPEAKS-FIRST:0123456789';

  for (const dribble of [false, true]) {
    for (const [label, atyp] of [['IPv4 (atyp 1)', 0x01], ['domain (atyp 3)', 0x03], ['IPv6 (atyp 4)', 0x04]]) {
      const echo = await startEcho(SENTINEL);
      const proxy = await startFakeSocks5({ forwardPort: echo.port, replyAtyp: atyp, dribble });
      const bridge = useBridge(await startSocks5Bridge({ host: '127.0.0.1', port: proxy.port, remoteDns: true }));
      const how = dribble ? 'byte-at-a-time' : 'whole frames';

      const { status, sock, rest } = await connectThroughBridge(bridge.port, 'api.anthropic.com:443');
      check(`${label}, ${how}: CONNECT returns 200`, status.includes('200'), status);

      // Anything the origin sent before the client spoke must arrive
      // byte-exact. A short drain prepends leftover reply bytes here; a
      // long one bites off the front of the sentinel.
      const seen = await new Promise((resolve, reject) => {
        let out = rest.toString();
        if (out.length >= SENTINEL.length) { resolve(out); return; }
        sock.on('data', (d) => { out += d.toString(); if (out.length >= SENTINEL.length) resolve(out); });
        sock.on('error', reject);
        setTimeout(() => resolve(out), 3000).unref?.();
      });
      check(`${label}, ${how}: tunnel starts at the origin's first byte`,
        seen.startsWith(SENTINEL), JSON.stringify(seen.slice(0, 48)));

      sock.destroy();
      await bridge.close(); await proxy.close(); await echo.close();
    }
  }
}

// ======================================================================
// The seam between the bridge and the fetch wrapper. Both ends are tested
// (URL parsing in outbound-proxy.mjs, the wire protocol above) and the
// join between them was not — which is where the one fatal regression
// lives: hand `config.url` to Bun's fetch instead of `bridge.proxyUrl`
// and every upstream request throws UnsupportedProxyProtocol, or worse
// the bridge relays for anyone once the token stops being sent.
header('installEgressProxy — fetch is pointed at the bridge, with the token');
{
  const echo = await startEcho();
  const proxy = await startFakeSocks5({ forwardPort: echo.port });
  const cfg = parseOutboundProxy(`socks5h://127.0.0.1:${proxy.port}`);

  const saved = globalThis.fetch;
  const seen = [];
  globalThis.fetch = ((input, init) => {
    seen.push({ input: String(input?.url ?? input), proxy: init?.proxy });
    return Promise.resolve(new Response('ok'));
  });
  const bridge = await installEgressProxy(cfg);
  await globalThis.fetch('https://api.anthropic.com/v1/messages');
  await globalThis.fetch('http://127.0.0.1:9/loopback');
  globalThis.fetch = saved;

  const upstream = seen[0], local = seen[1];
  check('upstream fetch is routed at the loopback bridge', upstream.proxy === bridge.proxyUrl, String(upstream.proxy));
  check('the socks5h URL is never handed to fetch', !String(upstream.proxy).startsWith('socks5'));
  check('the bridge token rides along', String(upstream.proxy).includes('dario:'));
  check('localhost still bypasses the proxy', local.proxy === undefined, String(local.proxy));

  await bridge.close(); await proxy.close(); await echo.close();
}

// ======================================================================
header('unreachable proxy fails fast rather than hanging');
{
  // Port 1 on loopback: nothing listens, connection refused immediately.
  const bridge = useBridge(await startSocks5Bridge({ host: '127.0.0.1', port: 1, remoteDns: true, timeoutMs: 2000 }));
  const r = await connectThroughBridge(bridge.port, 'api.anthropic.com:443');
  check('dead proxy → 502', r.status.includes('502'));
  r.sock.destroy();
  await bridge.close();
}

// ======================================================================
header('tunnel teardown and buffering');
{
  const echo = await startEcho();
  const proxy = await startFakeSocks5({ forwardPort: echo.port });
  const bridge = useBridge(await startSocks5Bridge({ host: '127.0.0.1', port: proxy.port, remoteDns: true }));

  // The client half closing must take the SOCKS half with it. Without
  // that, every abandoned tunnel leaks an fd until the proxy times it
  // out — and fetch's connection pool abandons tunnels constantly.
  const { sock } = await connectThroughBridge(bridge.port, 'api.anthropic.com:443');
  await roundTrip(sock, 'x');
  sock.destroy();
  const live = await new Promise((resolve) => {
    const deadline = Date.now() + 3000;
    const poll = () => proxy.server.getConnections((_e, n) => {
      if (n === 0 || Date.now() > deadline) resolve(n);
      else setTimeout(poll, 25);
    });
    poll();
  });
  check('client close tears down the upstream SOCKS socket', live === 0, `${live} still open`);

  // The handshake reader must let go of the socket once the tunnel is
  // up. Left attached it re-buffers every buffered byte on each chunk —
  // O(n^2) copying and full retention of the transfer (24 MiB in cost
  // 137 MiB of RSS). Memory must not track transfer size. The transfer
  // is deliberately large so the constant cost of socket buffers stays
  // small next to the ~4-5x growth the bug produced.
  const BYTES = 128 * 1024 * 1024;
  const blob = Buffer.alloc(64 * 1024, 0x61);
  const blaster = createNetServer((s) => {
    let sent = 0;
    const pump = () => {
      while (sent < BYTES) { sent += blob.length; if (!s.write(blob)) return; }
      s.end();
    };
    s.on('drain', pump); s.on('error', () => {}); s.resume(); pump();
  });
  const blasterPort = await listen(blaster);
  const bulkProxy = await startFakeSocks5({ forwardPort: blasterPort });
  const bulkBridge = useBridge(await startSocks5Bridge({ host: '127.0.0.1', port: bulkProxy.port, remoteDns: true }));

  global.gc?.();
  const rssBefore = process.memoryUsage().rss;
  const { sock: bulk } = await connectThroughBridge(bulkBridge.port, 'api.anthropic.com:443');
  let got = 0;
  await new Promise((resolve, reject) => {
    bulk.on('data', (d) => { got += d.length; });
    bulk.on('close', resolve);
    bulk.on('error', reject);
    setTimeout(() => reject(new Error('bulk transfer timed out')), 30_000).unref?.();
  });
  global.gc?.();
  const grew = process.memoryUsage().rss - rssBefore;
  check('bulk transfer completes', got >= BYTES, `${got} of ${BYTES}`);
  // Generous ceiling: the point is that growth is bounded by socket
  // buffers, not proportional to the transfer. Pre-fix this was ~5.7x.
  check('memory does not track transfer size', grew < BYTES / 2,
    `RSS grew ${(grew / 1048576).toFixed(1)} MiB on a ${(BYTES / 1048576).toFixed(0)} MiB transfer`);

  bulk.destroy();
  await bulkBridge.close(); await bulkProxy.close(); await close(blaster);
  await bridge.close(); await proxy.close(); await echo.close();
}

console.log(`\n${'='.repeat(70)}\n  ${pass} pass, ${fail} fail\n${'='.repeat(70)}`);
process.exit(fail === 0 ? 0 : 1);
