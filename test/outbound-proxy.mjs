// Unit tests for src/outbound-proxy.ts (v3.35.0). Pure decision functions
// only — no fetch wrapping, no live proxy. Validates parseOutboundProxy
// + isLocalhostUrl behavior against the documented contract.

import { parseOutboundProxy, isLocalhostUrl } from '../dist/outbound-proxy.js';
import { resolveEgressProxyFlag } from '../dist/cli.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}
function header(label) {
  console.log(`\n======================================================================`);
  console.log(`  ${label}`);
  console.log(`======================================================================`);
}
function expectThrows(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// ======================================================================
//  parseOutboundProxy — empty / undefined returns null (no proxy)
// ======================================================================
header('parseOutboundProxy — null / empty');
{
  check('undefined returns null', parseOutboundProxy(undefined) === null);
  check('empty string returns null', parseOutboundProxy('') === null);
  check('whitespace-only returns null', parseOutboundProxy('   ') === null);
}

// ======================================================================
//  parseOutboundProxy — happy path http / https
// ======================================================================
header('parseOutboundProxy — http / https accepted');
{
  const httpResult = parseOutboundProxy('http://127.0.0.1:8080');
  check('http://... parses', httpResult !== null);
  check('http scheme detected', httpResult?.scheme === 'http');
  check('display matches input', httpResult?.display === 'http://127.0.0.1:8080/');

  const httpsResult = parseOutboundProxy('https://proxy.example.com:443');
  check('https://... parses', httpsResult !== null);
  check('https scheme detected', httpsResult?.scheme === 'https');
}

// ======================================================================
//  parseOutboundProxy — credentials in URL get masked in display
// ======================================================================
header('parseOutboundProxy — credentials masked in display');
{
  const r = parseOutboundProxy('http://user:secret@proxy.host:8080');
  check('parses successfully', r !== null);
  check('display masks username', r?.display.includes('***') ?? false);
  check('display does NOT contain real password', !(r?.display.includes('secret') ?? true));
  check('url field preserves real value (passed to fetch)', r?.url.includes('secret') ?? false);
}

// ======================================================================
//  parseOutboundProxy — SOCKS5 accepted, SOCKS4 rejected
// ======================================================================
header('parseOutboundProxy — SOCKS5 accepted');
{
  const h = parseOutboundProxy('socks5h://127.0.0.1:1080');
  check('socks5h parses', h !== null);
  check('socks5h scheme detected', h?.scheme === 'socks5h');
  check('socks5h resolves DNS remotely', h?.socks?.remoteDns === true);
  check('socks5h host parsed', h?.socks?.host === '127.0.0.1');
  check('socks5h port parsed', h?.socks?.port === 1080);

  const p = parseOutboundProxy('socks5://10.0.0.2:9050');
  check('socks5 parses', p !== null);
  check('socks5 scheme detected', p?.scheme === 'socks5');
  check('socks5 resolves DNS locally', p?.socks?.remoteDns === false);

  // Port is optional — 1080 is the registered SOCKS default.
  const d = parseOutboundProxy('socks5h://proxy.internal');
  check('socks5h defaults to port 1080', d?.socks?.port === 1080);

  // Credentials ride the URL and must be decoded for the RFC 1929 frame.
  const c = parseOutboundProxy('socks5h://alice:s%40cret@proxy.host:1080');
  check('socks5h username parsed', c?.socks?.username === 'alice');
  check('socks5h password percent-decoded', c?.socks?.password === 's@cret');
  check('socks5h display masks credentials', c?.display.includes('***') ?? false);
  check('socks5h display leaks no password', !(c?.display.includes('s@cret') ?? true));

  // IPv6 literal keeps its brackets in the URL but not on the wire.
  const v6 = parseOutboundProxy('socks5h://[::1]:1080');
  check('socks5h IPv6 host unbracketed', v6?.socks?.host === '::1');
}

header('parseOutboundProxy — SOCKS4 rejected');
{
  for (const scheme of ['socks4', 'socks4a', 'socks']) {
    const msg = expectThrows(() => parseOutboundProxy(`${scheme}://127.0.0.1:1080`));
    check(`${scheme} is rejected`, msg !== null);
    check(`${scheme} error points at socks5h`, msg?.includes('socks5h') ?? false);
  }
}

header('parseOutboundProxy — SOCKS URL with path rejected');
{
  const msg = expectThrows(() => parseOutboundProxy('socks5h://127.0.0.1:1080/api'));
  check('path on a SOCKS URL is rejected', msg !== null);
  check('error explains SOCKS URL shape', msg?.includes('host, port') ?? false);
}

// ======================================================================
//  parseOutboundProxy — other schemes rejected
// ======================================================================
header('parseOutboundProxy — non-http schemes rejected');
{
  const msg1 = expectThrows(() => parseOutboundProxy('ftp://example.com'));
  check('ftp:// rejected', msg1 !== null);
  check('error mentions http/https expected', msg1?.includes('http://') ?? false);

  const msg2 = expectThrows(() => parseOutboundProxy('file:///etc/passwd'));
  check('file:// rejected', msg2 !== null);
}

// ======================================================================
//  parseOutboundProxy — invalid URL rejected with parse error
// ======================================================================
header('parseOutboundProxy — invalid URL');
{
  const msg = expectThrows(() => parseOutboundProxy('not a url'));
  check('garbage rejected', msg !== null);
  check('error explains expected format', msg?.includes('valid URL') ?? false);
}

// ======================================================================
//  isLocalhostUrl — loopback detection
// ======================================================================
header('isLocalhostUrl — loopback / non-loopback');
{
  // Loopback
  check('http://localhost:3456', isLocalhostUrl('http://localhost:3456'));
  check('http://127.0.0.1:3456', isLocalhostUrl('http://127.0.0.1:3456'));
  check('http://[::1]:3456 (IPv6 loopback)', isLocalhostUrl('http://[::1]:3456'));
  check('https://localhost', isLocalhostUrl('https://localhost'));
  check('foo.localhost subdomain', isLocalhostUrl('http://foo.localhost'));

  // Non-loopback
  check('https://api.anthropic.com is NOT localhost', !isLocalhostUrl('https://api.anthropic.com'));
  check('https://api.openai.com is NOT localhost', !isLocalhostUrl('https://api.openai.com'));
  check('http://192.168.1.1 is NOT localhost', !isLocalhostUrl('http://192.168.1.1'));
  check('http://10.0.0.1 is NOT localhost', !isLocalhostUrl('http://10.0.0.1'));

  // Object input shapes
  check('URL object with localhost', isLocalhostUrl(new URL('http://localhost:3456')));
  check('Request-shaped object with .url localhost', isLocalhostUrl({ url: 'http://localhost:3456' }));

  // Edge cases
  check('null returns false (not loopback)', isLocalhostUrl(null) === false);
  check('undefined returns false', isLocalhostUrl(undefined) === false);
  check('empty string returns false', isLocalhostUrl('') === false);
  check('garbage string returns false', isLocalhostUrl('not a url') === false);
}

// ======================================================================
//  resolveEgressProxyFlag — CLI > env > legacy env > config file
// ======================================================================
header('resolveEgressProxyFlag — precedence');
{
  const CLI = 'socks5h://cli:1080';
  const ENV = 'socks5h://env:1080';
  const LEGACY = 'socks5h://legacy:1080';
  const FILE = 'socks5h://file:1080';

  check('nothing configured → undefined',
    resolveEgressProxyFlag([], {}, null) === undefined);

  check('config file alone is used',
    resolveEgressProxyFlag([], {}, FILE) === FILE);

  check('DARIO_EGRESS_PROXY beats the config file',
    resolveEgressProxyFlag([], { DARIO_EGRESS_PROXY: ENV }, FILE) === ENV);

  check('legacy DARIO_UPSTREAM_PROXY still works',
    resolveEgressProxyFlag([], { DARIO_UPSTREAM_PROXY: LEGACY }, FILE) === LEGACY);

  check('DARIO_EGRESS_PROXY beats the legacy env var',
    resolveEgressProxyFlag([], { DARIO_EGRESS_PROXY: ENV, DARIO_UPSTREAM_PROXY: LEGACY }, FILE) === ENV);

  check('--egress-proxy=URL beats every lower layer',
    resolveEgressProxyFlag([`--egress-proxy=${CLI}`], { DARIO_EGRESS_PROXY: ENV }, FILE) === CLI);

  check('--egress-proxy URL (separated) is accepted',
    resolveEgressProxyFlag(['--egress-proxy', CLI], { DARIO_EGRESS_PROXY: ENV }, FILE) === CLI);

  // Back-compat: the pre-existing spellings keep working.
  check('--upstream-proxy alias still honored',
    resolveEgressProxyFlag([`--upstream-proxy=${CLI}`], {}, FILE) === CLI);
  check('--via alias still honored',
    resolveEgressProxyFlag([`--via=${CLI}`], {}, FILE) === CLI);
  check('--upstream-proxy separated form honored',
    resolveEgressProxyFlag(['--upstream-proxy', CLI], {}, FILE) === CLI);

  // An explicit empty value is "route direct", not "fall through" —
  // otherwise `--egress-proxy=` on a host with the env var set would
  // silently keep proxying.
  check('--egress-proxy= disables a configured env var',
    resolveEgressProxyFlag(['--egress-proxy='], { DARIO_EGRESS_PROXY: ENV }, FILE) === undefined);
  check('empty env var disables the config file',
    resolveEgressProxyFlag([], { DARIO_EGRESS_PROXY: '' }, FILE) === undefined);

  // A bare flag would otherwise route traffic direct while the operator
  // believed it was proxied — the one failure mode worth an exception.
  check('bare --egress-proxy with no value throws',
    expectThrows(() => resolveEgressProxyFlag(['--egress-proxy'], {}, null)) !== null);
  check('--egress-proxy followed by another flag throws',
    expectThrows(() => resolveEgressProxyFlag(['--egress-proxy', '--port=1'], {}, null)) !== null);

  // ── Ambiguities pinned deliberately ───────────────────────────────
  // Each of these has two defensible answers, so the point is that the
  // behaviour is chosen and asserted rather than whatever argument order
  // happens to fall out of the implementation.

  // Within argv, the LAST occurrence wins, whichever spelling it uses.
  // This used to scan by flag name, which made the first one win — and
  // made the case below route direct while the operator was looking at an
  // explicit proxy URL on the command line.
  check('repeated --egress-proxy: the last wins',
    resolveEgressProxyFlag(['--egress-proxy=http://a:1', '--egress-proxy=http://b:2'], {}, null) === 'http://b:2');
  check('a real URL after an empty one wins (and is not silently dropped)',
    resolveEgressProxyFlag(['--egress-proxy=', '--egress-proxy=http://real:1080'], {}, null) === 'http://real:1080');
  check('an empty value last still clears — an explicit override, typed last',
    resolveEgressProxyFlag(['--egress-proxy=http://real:1080', '--egress-proxy='], {}, null) === undefined);
  check('mixed forms resolve in argv order, not by form',
    resolveEgressProxyFlag(['--egress-proxy=http://a:1', '--egress-proxy', 'http://b:2'], {}, null) === 'http://b:2');

  // Aliases are the same layer, so argv order decides between them too.
  // The old rule ranked by name, so `--via=A --upstream-proxy=B` picked B
  // regardless of which the operator meant to override.
  check('--via after --egress-proxy wins',
    resolveEgressProxyFlag(['--egress-proxy=http://a:1', '--via=http://b:2'], {}, null) === 'http://b:2');
  check('--egress-proxy after --via wins',
    resolveEgressProxyFlag(['--via=http://b:2', '--egress-proxy=http://a:1'], {}, null) === 'http://a:1');

  // The value of a space-form flag is consumed, so a URL that happens to
  // look like a later flag's value can't be re-read as one.
  check('space form consumes its value',
    resolveEgressProxyFlag(['--egress-proxy', 'http://a:1'], {}, FILE) === 'http://a:1');

  // Prefix collisions: a longer flag that merely starts the same must
  // not be mistaken for this one.
  check('--egress-proxy-foo=X is not --egress-proxy',
    resolveEgressProxyFlag(['--egress-proxy-foo=http://a:1'], {}, FILE) === FILE);
  check('--via-something=X is not --via',
    resolveEgressProxyFlag(['--via-something=http://a:1'], {}, FILE) === FILE);

  // An empty LEGACY env clears too, and stops the chain — same rule as
  // the current name, so migrating between them changes nothing.
  check('empty legacy env disables the config file',
    resolveEgressProxyFlag([], { DARIO_UPSTREAM_PROXY: '' }, FILE) === undefined);
  check('whitespace-only env is treated as empty, not as a URL',
    resolveEgressProxyFlag([], { DARIO_EGRESS_PROXY: '   ' }, FILE) === undefined);
  // The current name is consulted first even when it is the empty one.
  check('empty current env wins over a set legacy env',
    resolveEgressProxyFlag([], { DARIO_EGRESS_PROXY: '', DARIO_UPSTREAM_PROXY: LEGACY }, FILE) === undefined);
}

// ======================================================================
//  Summary
// ======================================================================
console.log(`\n======================================================================`);
console.log(`  ${pass} pass, ${fail} fail`);
console.log(`======================================================================`);
process.exit(fail === 0 ? 0 : 1);
