#!/usr/bin/env bun

// A slow body upload must not outlive the token the request was selected
// against — and the thing that guarantees it is an equality between two
// constants in two different files.
//
// proxy.ts captures the bearer off the selected account at selection time
// (`accessToken = poolAccount?.accessToken ?? ''`) and then awaits the request
// body. Between that capture and `upstreamAuthHeaders(upstreamApiKey,
// accessToken)` there is no second look at the account: no expiry re-check, no
// re-read of accessToken, no re-selection. So the body read is the one
// unbounded thing inside the window where the bearer must stay valid, and the
// only reason a slow uploader cannot drain that window is:
//
//   TOKEN_EXPIRY_MARGIN_MS = 30_000   // life select() guarantees (pool.ts)
//   BODY_READ_TIMEOUT_MS   = 30_000   // longest a body may take (proxy.ts)
//
// select() rejects an account with `expiresAt <= now + margin`, strictly, so an
// eligible token has MORE than 30s left; the body read is destroyed at exactly
// 30s. The read therefore always loses the race, by a margin that is small but
// never negative. That was worth checking rather than assuming: the hypothesis
// going in was that these two being equal left no room for the upstream round
// trip and let expired bearers reach Anthropic. It does not — the body timeout
// fires first — and this test exists so the next person does not re-hunt it.
//
// What it guards is the coupling, which was previously invisible: a bare
// `30_000` literal in pool.ts and an unrelated named constant in proxy.ts, in
// different files, with nothing tying them together. Raise the body timeout
// above the margin and dario sends dead bearers on slow uploads — Anthropic
// 401s, dario books an auth failure, and a seat with sound credentials drops
// into auth cool-down. BODY_READ_TIMEOUT_MS is now clamped to the margin so the
// two cannot drift; this asserts the behaviour that clamp buys.

import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { TOKEN_EXPIRY_MARGIN_MS } from '../dist/pool.js';

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); }
}
function header(name) { console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`); }

const home = await mkdtemp(join(tmpdir(), 'dario-token-expiry-'));
process.on('exit', () => rmSync(home, { recursive: true, force: true }));
process.env.HOME = home;
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';

// Every account on disk starts inside the refresh loop's 45-minute window, so
// the startup self-heal (#790) always refreshes before serving — there is no
// on-disk expiry short enough to survive it. Let that refresh succeed and have
// it hand back the short-lived token instead. Just past the margin, so the
// account is eligible at selection and dies while a slow body is still
// arriving. The 15-minute interval will not fire again inside the test.
const TOKEN_LIFETIME_MS = TOKEN_EXPIRY_MARGIN_MS + 1_000;
let expiresAt = null;

const accountsDir = join(home, '.dario', 'accounts');
await mkdir(accountsDir, { recursive: true });
await writeFile(join(accountsDir, 'solo.json'), JSON.stringify({
  alias: 'solo',
  accessToken: 'token-stale',
  refreshToken: 'refresh-solo',
  expiresAt: Date.now() + 60_000,
  scopes: ['user:inference'],
  deviceId: 'device-solo',
  accountUuid: 'account-solo',
}));

const upstreamCalls = [];
const fakeFetch = async (url, init) => {
  const u = String(url);
  if (u.includes('/oauth/profile')) {
    return new Response(JSON.stringify({ account: { has_claude_max: true } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.includes('/oauth/token')) {
    expiresAt = Date.now() + TOKEN_LIFETIME_MS;
    return new Response(JSON.stringify({
      access_token: 'token-doomed',
      refresh_token: 'refresh-solo-2',
      expires_in: TOKEN_LIFETIME_MS / 1000,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.includes('/v1/messages')) {
    upstreamCalls.push({
      at: Date.now(),
      authorization: new Headers(init?.headers).get('authorization') ?? '',
    });
    return new Response(JSON.stringify({
      id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-haiku-4-5-20251001',
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};
// refreshAccountToken() reaches for the global fetch, not the injected one.
globalThis.fetch = fakeFetch;

const { startProxy } = await import('../dist/proxy.js');
const proxy = await startProxy({ port: 0, fetchImpl: fakeFetch, verbose: false });

if (expiresAt === null) {
  console.error('  setup: the startup self-heal never refreshed — nothing under test');
  await proxy.close();
  process.exit(1);
}

const body = JSON.stringify({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 16,
  messages: [{ role: 'user', content: 'hello' }],
});

// A slow uploader: headers and half the body, then a pause that outlasts the
// token, then the rest. The body read must be cut off before the token dies.
function trickle(holdMs) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: proxy.host, port: proxy.port, path: '/v1/messages', method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'dario',
        'anthropic-version': '2023-06-01',
        'content-length': Buffer.byteLength(body),
      },
    }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode }));
    });
    // A destroyed request surfaces as a socket error, which is the pass here.
    req.on('error', (e) => resolve({ status: null, error: e.code ?? e.message }));
    const half = Math.floor(body.length / 2);
    req.write(body.slice(0, half));
    const timer = setTimeout(() => { try { req.end(body.slice(half)); } catch { /* destroyed */ } }, holdMs);
    timer.unref?.();
  });
}

header('a body read is cut off before the token it holds can expire');
const res = await trickle((expiresAt - Date.now()) + 1_500);

check('the slow upload did not reach upstream', upstreamCalls.length === 0,
  `${upstreamCalls.length} call(s), first at ${upstreamCalls[0]?.at - expiresAt}ms past expiry`);
check('it was refused rather than hung', res.status !== undefined);

// The invariant the above depends on. Asserted directly, and it carries the
// weight: raising BODY_READ_TIMEOUT_MS to a free 60_000 in the built proxy
// leaves the two behavioural checks above still passing — the request fails for
// a different reason and never reaches upstream — and is caught only here. A
// structural assertion is the honest guard for a structural coupling.
header('the coupling that makes it safe');
const proxySrc = await Bun.file(new URL('../dist/proxy.js', import.meta.url)).text();
const m = /BODY_READ_TIMEOUT_MS\s*=\s*Math\.min\(\s*([0-9_]+)\s*,\s*TOKEN_EXPIRY_MARGIN_MS\s*\)/.exec(proxySrc);
check('BODY_READ_TIMEOUT_MS is clamped to the margin, not a free literal', m !== null);
if (m) {
  const nominal = Number(m[1].replace(/_/g, ''));
  const effective = Math.min(nominal, TOKEN_EXPIRY_MARGIN_MS);
  check('the effective body timeout does not exceed the expiry margin',
    effective <= TOKEN_EXPIRY_MARGIN_MS, `${effective} vs ${TOKEN_EXPIRY_MARGIN_MS}`);
  // Strictness matters: select() rejects `expiresAt <= now + margin`, so an
  // eligible token has strictly more than the margin left and equality is safe.
  check('equality is the intended configuration', effective === TOKEN_EXPIRY_MARGIN_MS,
    `${effective} vs ${TOKEN_EXPIRY_MARGIN_MS}`);
}

await proxy.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
