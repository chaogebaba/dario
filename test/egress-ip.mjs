#!/usr/bin/env bun
// Egress IP verification — the check that turns "the proxy accepted my
// connection" into "the proxy is actually carrying my traffic".
//
// The parser is the part most likely to rot: DARIO_EGRESS_IP_URL lets an
// operator point at any endpoint, so it has to cope with Cloudflare's
// key=value trace, a bare address, and JSON echo services — while still
// returning null for a captive portal's login page rather than a
// confident-looking string.

import { createServer } from 'node:http';
import {
  parseEgressIp,
  egressIpUrl,
  checkEgressIp,
  DEFAULT_EGRESS_IP_URL,
  setEgressRoute,
  recordEgressCheck,
  getEgressSnapshot,
  refreshEgressIpIfStale,
  resetEgressSnapshot,
} from '../dist/egress-ip.js';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' :: ' + detail : ''}`); }
}
function header(n) { console.log(`\n${'='.repeat(70)}\n  ${n}\n${'='.repeat(70)}`); }

// ======================================================================
header('parseEgressIp — tolerant of endpoint, strict about the value');
{
  const trace = 'fl=123abc\nh=cloudflare.com\nip=203.0.113.7\nts=1700000000\nvisit_scheme=https\n';
  check('cdn-cgi/trace key=value', parseEgressIp(trace) === '203.0.113.7');
  check('trace with CRLF line endings', parseEgressIp(trace.replace(/\n/g, '\r\n')) === '203.0.113.7');
  check('trace with an IPv6 address', parseEgressIp('ip=2001:db8::1\nts=1\n') === '2001:db8::1');

  check('bare IPv4 body (ifconfig.me/ip)', parseEgressIp('198.51.100.42\n') === '198.51.100.42');
  check('bare IPv6 body', parseEgressIp('  2001:db8::dead  ') === '2001:db8::dead');

  check('JSON {ip}', parseEgressIp('{"ip":"192.0.2.9"}') === '192.0.2.9');
  check('JSON {address}', parseEgressIp('{"address":"192.0.2.10"}') === '192.0.2.10');
  // httpbin joins the forwarded chain; the client-visible address is first.
  check('JSON {origin} forwarded chain takes the first hop',
    parseEgressIp('{"origin":"192.0.2.11, 10.0.0.1"}') === '192.0.2.11');

  // The failure that matters: never invent an address.
  check('captive-portal HTML → null', parseEgressIp('<html><body>Sign in</body></html>') === null);
  check('empty body → null', parseEgressIp('') === null);
  check('whitespace-only body → null', parseEgressIp('   \n  ') === null);
  check('trace whose ip= is not an address → null', parseEgressIp('ip=not-an-ip\nts=1\n') === null);
  check('JSON with a non-address ip → null', parseEgressIp('{"ip":"unknown"}') === null);
  check('malformed JSON → null', parseEgressIp('{"ip":') === null);
  // A hostname is not an address — resolving it here would report the
  // wrong thing with total confidence.
  check('hostname → null', parseEgressIp('proxy.example.com') === null);
}

// ======================================================================
header('egressIpUrl — env > config file > default');
{
  check('nothing set → Cloudflare trace', egressIpUrl({}, null) === DEFAULT_EGRESS_IP_URL);
  check('config file wins over default', egressIpUrl({}, 'https://cfg.example/ip') === 'https://cfg.example/ip');
  check('env wins over config file',
    egressIpUrl({ DARIO_EGRESS_IP_URL: 'https://env.example/ip' }, 'https://cfg.example/ip') === 'https://env.example/ip');
  // Empty means "I did not mean to override", not "use the empty string".
  check('empty env falls back to default',
    egressIpUrl({ DARIO_EGRESS_IP_URL: '' }, null) === DEFAULT_EGRESS_IP_URL);
  check('whitespace env falls back to default',
    egressIpUrl({ DARIO_EGRESS_IP_URL: '   ' }, null) === DEFAULT_EGRESS_IP_URL);
  check('empty config value falls back to default', egressIpUrl({}, '  ') === DEFAULT_EGRESS_IP_URL);
  check('env is trimmed', egressIpUrl({ DARIO_EGRESS_IP_URL: ' https://x/ip ' }, null) === 'https://x/ip');
}

// ======================================================================
header('checkEgressIp — a failed probe is a result, never a throw');
{
  let mode = 'ok';
  const server = createServer((req, res) => {
    if (mode === 'ok') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ip=203.0.113.7\nts=1\n'); }
    else if (mode === 'bad-status') { res.writeHead(502); res.end('SOCKS5 handshake to 127.0.0.1:9 failed — ECONNREFUSED\n'); }
    else if (mode === 'garbage') { res.writeHead(200); res.end('<html>captive portal</html>'); }
    else if (mode === 'hang') { /* never respond */ }
  });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const url = `http://127.0.0.1:${port}/trace`;

  const ok = await checkEgressIp(url);
  check('success reports the address', ok.ok === true && ok.ip === '203.0.113.7', JSON.stringify(ok));
  check('success records the endpoint asked', ok.url === url);
  check('success records latency', typeof ok.latencyMs === 'number' && ok.latencyMs >= 0);

  mode = 'bad-status';
  const bad = await checkEgressIp(url);
  check('non-2xx is a failure, not a throw', bad.ok === false && bad.ip === null);
  // The bridge answers 502 with the SOCKS reason in the body. A bare
  // "502" would leave the operator with nothing to act on.
  check('non-2xx surfaces the body as the reason',
    /ECONNREFUSED/.test(bad.error ?? ''), bad.error);

  mode = 'garbage';
  const garbage = await checkEgressIp(url);
  check('unparseable body is a failure', garbage.ok === false && garbage.ip === null);
  check('unparseable body says so', /no recognisable IP/.test(garbage.error ?? ''), garbage.error);

  mode = 'hang';
  const t0 = Date.now();
  const timedOut = await checkEgressIp(url, 300);
  check('a hanging endpoint times out', timedOut.ok === false);
  check('timeout is bounded by the argument', Date.now() - t0 < 5000, `${Date.now() - t0}ms`);
  check('timeout says how long it waited', /300ms/.test(timedOut.error ?? ''), timedOut.error);

  const refused = await checkEgressIp('http://127.0.0.1:1/trace', 2000);
  check('connection refused is a failure', refused.ok === false && refused.ip === null);
  check('connection refused names the endpoint', /127\.0\.0\.1:1/.test(refused.error ?? ''), refused.error);

  await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
}

// ======================================================================
header('snapshot — cached, single-flighted, never in a request path');
{
  resetEgressSnapshot();
  const empty = getEgressSnapshot();
  check('starts empty', empty.proxy === null && empty.last === null);
  check('starts on the default endpoint', empty.probeUrl === DEFAULT_EGRESS_IP_URL);

  setEgressRoute('socks5h://***:***@vpn.example:1080', 'socks5h', 'https://probe.example/ip');
  const routed = getEgressSnapshot();
  check('route is recorded', routed.proxy === 'socks5h://***:***@vpn.example:1080' && routed.scheme === 'socks5h');
  check('probe url is recorded', routed.probeUrl === 'https://probe.example/ip');
  // Whatever is shown must already be redacted by the caller; the
  // snapshot is read by /health and the TUI.
  check('stored route carries no credentials', !/hunter2|:.*@vpn/.test(routed.proxy.replace('***:***@', '')));

  recordEgressCheck({ ok: true, ip: '203.0.113.9', url: 'https://probe.example/ip', checkedAt: Date.now(), latencyMs: 5 });
  check('result is readable', getEgressSnapshot().last?.ip === '203.0.113.9');

  // getEgressSnapshot hands out a copy — a caller mutating what it got
  // must not rewrite what /health reports next time.
  const copy = getEgressSnapshot();
  copy.last.ip = '10.0.0.1';
  copy.proxy = 'tampered';
  check('snapshot is a copy, not the live object',
    getEgressSnapshot().last?.ip === '203.0.113.9' && getEgressSnapshot().proxy !== 'tampered');

  // Fresh result → no refresh. This is what keeps a docker healthcheck
  // polling /health every second from firing a probe every second.
  const before = getEgressSnapshot().last.checkedAt;
  refreshEgressIpIfStale(300_000);
  await new Promise((r) => setTimeout(r, 50));
  check('a fresh result is not re-probed', getEgressSnapshot().last.checkedAt === before);

  // Stale result → refresh happens, against an endpoint that fails; the
  // point is that it runs and replaces the cached value, not that it
  // succeeds.
  recordEgressCheck({ ok: true, ip: '203.0.113.9', url: 'http://127.0.0.1:1/ip', checkedAt: Date.now() - 600_000, latencyMs: 5 });
  setEgressRoute('socks5h://vpn.example:1080', 'socks5h', 'http://127.0.0.1:1/ip');
  refreshEgressIpIfStale(300_000);
  const settled = await (async () => {
    for (let i = 0; i < 100; i++) {
      if (getEgressSnapshot().last?.ok === false) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  })();
  check('a stale result is re-probed in the background', settled);
  resetEgressSnapshot();
}

console.log(`\n${'='.repeat(70)}\n  ${pass} pass, ${fail} fail\n${'='.repeat(70)}`);
process.exit(fail === 0 ? 0 : 1);
