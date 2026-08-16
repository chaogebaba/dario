#!/usr/bin/env node
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

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' :: ' + detail : ''}`); }
}
function header(n) { console.log(`\n${'='.repeat(70)}\n  ${n}\n${'='.repeat(70)}`); }

const listen = (server, port = 0) => new Promise((res) => server.listen(port, '127.0.0.1', () => res(server.address().port)));
const close = (server) => new Promise((res) => server.close(() => res()));

/** Echo server standing in for the origin behind the proxy. */
function startEcho() {
  const server = createNetServer((sock) => sock.pipe(sock));
  return listen(server).then((port) => ({ port, close: () => close(server) }));
}

/**
 * Minimal fake SOCKS5 server.
 *   opts.requireAuth  — demand RFC 1929 username/password
 *   opts.credentials  — { username, password } the fake will accept
 *   opts.failWith     — reply code to return instead of success (0x00)
 *   opts.forwardPort  — loopback port to splice the client to on success
 * Records the decoded CONNECT target on `.lastTarget`.
 */
function startFakeSocks5(opts = {}) {
  const state = { lastTarget: null, authAttempt: null };
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
          sock.write(Buffer.from([0x05, 0x02]));
          phase = 'auth';
        } else {
          sock.write(Buffer.from([0x05, 0x00]));
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
        sock.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
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

        // Success reply, then splice to the stand-in origin.
        sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
        const upstream = netConnect({ host: '127.0.0.1', port: opts.forwardPort }, () => {
          if (buf.length) upstream.write(buf);
          sock.pipe(upstream);
          upstream.pipe(sock);
        });
        upstream.on('error', () => sock.destroy());
        phase = 'tunnel';
      }
    });
    sock.on('error', () => {});
  });
  return listen(server).then((port) => ({ port, state, close: () => close(server) }));
}

/** Speak HTTP CONNECT to the bridge; resolve with status line + tunnel socket. */
function connectThroughBridge(bridgePort, target) {
  return new Promise((resolve, reject) => {
    const sock = netConnect({ host: '127.0.0.1', port: bridgePort }, () => {
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
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
  const bridge = await startSocks5Bridge({ host: '127.0.0.1', port: proxy.port, remoteDns: true });

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
  const bridge = await startSocks5Bridge({ host: '127.0.0.1', port: proxy.port, remoteDns: false });

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
  const bridge = await startSocks5Bridge({ host: '127.0.0.1', port: proxy.port, remoteDns: true });

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
  const bridge = await startSocks5Bridge({
    host: '127.0.0.1', port: proxy.port, remoteDns: true,
    username: 'alice', password: 's@cret',
  });

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
  const b1 = await startSocks5Bridge({
    host: '127.0.0.1', port: badCreds.port, remoteDns: true,
    username: 'alice', password: 'wrong',
  });
  const r1 = await connectThroughBridge(b1.port, 'api.anthropic.com:443');
  check('wrong password → 502', r1.status.includes('502'));
  check('502 body explains the rejection', r1.rest.toString().includes('rejected the supplied username/password'));
  check('502 body leaks no password', !r1.rest.toString().includes('wrong'));
  r1.sock.destroy(); await b1.close(); await badCreds.close();

  // Proxy demands auth, dario has no credentials configured.
  const needsAuth = await startFakeSocks5({ forwardPort: echo.port, requireAuth: true, credentials: {} });
  const b2 = await startSocks5Bridge({ host: '127.0.0.1', port: needsAuth.port, remoteDns: true });
  const r2 = await connectThroughBridge(b2.port, 'api.anthropic.com:443');
  check('missing credentials → 502', r2.status.includes('502'));
  check('502 tells the user to add credentials', r2.rest.toString().includes('socks5h://user:pass@'));
  r2.sock.destroy(); await b2.close(); await needsAuth.close();

  // Upstream refuses the CONNECT (reply 0x05, connection refused).
  const refuses = await startFakeSocks5({ forwardPort: echo.port, failWith: 0x05 });
  const b3 = await startSocks5Bridge({ host: '127.0.0.1', port: refuses.port, remoteDns: true });
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
  const bridge = await startSocks5Bridge({ host: '127.0.0.1', port: proxy.port, remoteDns: true });

  // Absolute-form GET (what a plain-HTTP proxy request looks like).
  const res = await fetch(`${bridge.url}/`, { method: 'GET' }).catch((e) => e);
  check('non-CONNECT request is answered 501', res?.status === 501);

  // A malformed CONNECT target must not reach the SOCKS layer.
  const bad = await connectThroughBridge(bridge.port, 'no-port-here');
  check('CONNECT without a port → 400', bad.status.includes('400'));
  bad.sock.destroy();

  await bridge.close(); await proxy.close(); await echo.close();
}

// ======================================================================
header('unreachable proxy fails fast rather than hanging');
{
  // Port 1 on loopback: nothing listens, connection refused immediately.
  const bridge = await startSocks5Bridge({ host: '127.0.0.1', port: 1, remoteDns: true, timeoutMs: 2000 });
  const r = await connectThroughBridge(bridge.port, 'api.anthropic.com:443');
  check('dead proxy → 502', r.status.includes('502'));
  r.sock.destroy();
  await bridge.close();
}

console.log(`\n${'='.repeat(70)}\n  ${pass} pass, ${fail} fail\n${'='.repeat(70)}`);
process.exit(fail === 0 ? 0 : 1);
