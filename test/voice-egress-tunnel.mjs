#!/usr/bin/env bun
/**
 * The voice relay honours an egress proxy instead of declining to run.
 *
 * The relay dials with node:https. installOutboundProxyWrapper only wraps
 * globalThis.fetch, so for as long as the relay had no tunnel of its own the
 * only safe thing it could do with --egress-proxy set was refuse: sending the
 * voice socket by the default route while every other upstream call went
 * through the proxy is the exact leak the operator configured against. It
 * refused with a 502, which meant voice was dead for everyone running an
 * egress proxy — and a SOCKS egress is the common case, since Bun's fetch
 * cannot speak SOCKS either and socks5-bridge.ts already exists to bridge it.
 *
 * That bridge is a loopback HTTP proxy that accepts CONNECT, which is exactly
 * the shape a raw TLS socket needs. The relay now tunnels through it: CONNECT
 * to the origin, then TLS over the tunnel with the real hostname for SNI and
 * certificate validation, so the proxy sees a CONNECT and nothing more.
 *
 * Verified against the live endpoint before this test was written: through a
 * SOCKS5 egress, api.anthropic.com answered 101 with a valid
 * Sec-WebSocket-Accept and held the socket open, and the egress IP stayed the
 * proxy's. What this file pins is the routing decision, which a live test
 * cannot assert cheaply: that the bytes went through the proxy at all, that a
 * refused CONNECT surfaces as a reason rather than a hang, and that the
 * decline still fires when there is no tunnel to use.
 */

import { createServer as createHttpServer } from 'node:http';
import { connect as netConnect, createServer as createTcpServer } from 'node:net';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Sandboxed HOME before the proxy module loads: homeDir() is what the account
// store reads, and the suite must never touch the operator's real ~/.dario.
const home = await mkdtemp(join(tmpdir(), 'dario-voice-egress-'));
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
  expiresAt: Date.now() + 8 * 60 * 60_000,  // far enough out that no refresh fires
  scopes: ['user:inference'],
  deviceId: 'device-a-main',
  accountUuid: 'account-a-main',
}));

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra !== undefined ? ` — ${extra}` : ''}`); }
}
function header(n) { console.log(`\n${'='.repeat(70)}\n  ${n}\n${'='.repeat(70)}`); }

const { startProxy } = await import('../dist/proxy.js');

const VOICE_PATH = '/api/ws/speech_to_text/voice_stream';
const QUERY = 'encoding=linear16&sample_rate=16000&channels=1';

/** Fake voice upstream: answers the upgrade with a valid 101. */
function startFakeUpstream() {
  const seen = [];
  const sockets = new Set();
  const server = createHttpServer((_req, res) => { res.writeHead(404); res.end(); });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.on('upgrade', (req, socket) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    socket.on('error', () => {});
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + 'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n');
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({
    port: server.address().port,
    get seen() { return seen; },
    close: () => new Promise((d) => { for (const s of sockets) s.destroy(); server.close(() => d()); }),
  })));
}

/** Fake CONNECT proxy, standing in for socks5-bridge.ts. */
function startConnectProxy({ refuse = false, requireAuth = null } = {}) {
  const connects = [];
  const sockets = new Set();
  const server = createTcpServer((client) => {
    sockets.add(client);
    client.on('error', () => {});
    client.on('close', () => sockets.delete(client));
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      client.removeListener('data', onData);
      const headText = buf.slice(0, end).toString('latin1');
      const target = /^CONNECT (\S+)/.exec(headText)?.[1] ?? '';
      const auth = /proxy-authorization: (.+)/i.exec(headText)?.[1]?.trim() ?? null;
      connects.push({ target, auth });
      if (refuse) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
      if (requireAuth && auth !== requireAuth) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
      const [host, port] = target.split(':');
      const up = netConnect(Number(port), host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const leftover = buf.slice(end + 4);
        if (leftover.length) up.write(leftover);
        client.pipe(up); up.pipe(client);
      });
      up.on('error', () => client.destroy());
      sockets.add(up); up.on('close', () => sockets.delete(up));
    };
    client.on('data', onData);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({
    port: server.address().port,
    get connects() { return connects; },
    close: () => new Promise((d) => { for (const s of sockets) s.destroy(); server.close(() => d()); }),
  })));
}

async function startDario(upstreamPort, extra = {}) {
  return startProxy({
    port: 0, host: '127.0.0.1',
    voiceUpstream: { host: '127.0.0.1', port: upstreamPort, tls: false },
    noLiveCapture: true,
    fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    ...extra,
  });
}

function upgradeRequest(host, port) {
  return 'GET ' + VOICE_PATH + '?' + QUERY + ' HTTP/1.1\r\n'
    + `Host: ${host}:${port}\r\n`
    + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
    + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
    + 'Sec-WebSocket-Version: 13\r\n'
    + 'Authorization: Bearer cc-own-token\r\n'
    + 'User-Agent: claude-cli/2.1.239 (external, cli)\r\n\r\n';
}

function speak(port, payload, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const sock = netConnect(port, '127.0.0.1');
    const done = () => { try { sock.destroy(); } catch {} resolve(buf.toString('latin1')); };
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
    sock.on('connect', () => sock.write(payload));
    sock.on('data', (d) => { buf = Buffer.concat([buf, d]); if (buf.includes('\r\n\r\n')) { clearTimeout(timer); done(); } });
    sock.on('error', () => { clearTimeout(timer); done(); });
    sock.on('close', () => { clearTimeout(timer); done(); });
  });
}

header('with a CONNECT tunnel, the relay runs and the bytes go through it');
{
  const upstream = await startFakeUpstream();
  const proxySrv = await startConnectProxy();
  const dario = await startDario(upstream.port, {
    egressProxyConfigured: true,
    egressConnectProxyUrl: `http://127.0.0.1:${proxySrv.port}`,
  });
  const res = await speak(dario.port, upgradeRequest('127.0.0.1', dario.port));
  check('the client got a 101', /^HTTP\/1\.1 101/.test(res), res.split('\r\n')[0]);
  check('the CONNECT proxy was used exactly once', proxySrv.connects.length === 1,
    JSON.stringify(proxySrv.connects));
  check('it was asked for the voice origin', proxySrv.connects[0]?.target === `127.0.0.1:${upstream.port}`,
    proxySrv.connects[0]?.target);
  check('the upstream saw the upgrade', upstream.seen.length === 1);
  check("and it carried the pool's bearer, not the client's",
    upstream.seen[0]?.auth !== undefined && upstream.seen[0].auth !== 'Bearer cc-own-token',
    upstream.seen[0]?.auth);
  await dario.close(); await proxySrv.close(); await upstream.close();
}

header('proxy credentials are presented when the tunnel URL carries them');
{
  const upstream = await startFakeUpstream();
  const expected = `Basic ${Buffer.from('dario:s3cr3t').toString('base64')}`;
  const proxySrv = await startConnectProxy({ requireAuth: expected });
  const dario = await startDario(upstream.port, {
    egressProxyConfigured: true,
    egressConnectProxyUrl: `http://dario:s3cr3t@127.0.0.1:${proxySrv.port}`,
  });
  const res = await speak(dario.port, upgradeRequest('127.0.0.1', dario.port));
  check('the tunnel authenticated and the relay got its 101', /^HTTP\/1\.1 101/.test(res), res.split('\r\n')[0]);
  check('Proxy-Authorization was sent', proxySrv.connects[0]?.auth === expected, proxySrv.connects[0]?.auth);
  await dario.close(); await proxySrv.close(); await upstream.close();
}

header('a refused CONNECT is reported, not hung on');
{
  const upstream = await startFakeUpstream();
  const proxySrv = await startConnectProxy({ refuse: true });
  const dario = await startDario(upstream.port, {
    egressProxyConfigured: true,
    egressConnectProxyUrl: `http://127.0.0.1:${proxySrv.port}`,
  });
  const res = await speak(dario.port, upgradeRequest('127.0.0.1', dario.port));
  check('answered 502 rather than hanging', /^HTTP\/1\.1 502/.test(res), res.split('\r\n')[0]);
  check('the reason names the tunnel', /egress tunnel/i.test(res), res.slice(0, 200));
  check('the upstream was never reached', upstream.seen.length === 0);
  await dario.close(); await proxySrv.close(); await upstream.close();
}

header('without a tunnel, an egress proxy still means decline');
{
  const upstream = await startFakeUpstream();
  const dario = await startDario(upstream.port, { egressProxyConfigured: true });
  const res = await speak(dario.port, upgradeRequest('127.0.0.1', dario.port));
  check('declined with 502', /^HTTP\/1\.1 502/.test(res), res.split('\r\n')[0]);
  check('the upstream was never reached', upstream.seen.length === 0);
  await dario.close(); await upstream.close();
}

header('with no egress proxy at all, nothing changes');
{
  const upstream = await startFakeUpstream();
  const proxySrv = await startConnectProxy();
  const dario = await startDario(upstream.port);
  const res = await speak(dario.port, upgradeRequest('127.0.0.1', dario.port));
  check('the client got a 101', /^HTTP\/1\.1 101/.test(res), res.split('\r\n')[0]);
  check('no CONNECT tunnel was opened', proxySrv.connects.length === 0);
  await dario.close(); await proxySrv.close(); await upstream.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
