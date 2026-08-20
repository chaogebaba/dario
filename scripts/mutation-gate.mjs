#!/usr/bin/env bun
/**
 * Mutation gate — proves the wire-fidelity suites fail when the fix they pin
 * is reverted.
 *
 * A suite that passes tells you nothing on its own: it passes just as happily
 * against code that never had the bug. The only evidence a test is load-bearing
 * is watching it go red when the behaviour it asserts is taken away. That was
 * done by hand once, in the session that landed the cc-wire-2.1.236 corpus —
 * revert a fix in the built output, watch a named assertion fail, rebuild. Six
 * mutations, six catching assertions, and nothing that would notice when the
 * seventh assertion silently stopped asserting.
 *
 * Each entry below is one such revert: a literal string swap in a built
 * `dist/*.js`, the suite that must go red, and the assertion LABEL that must be
 * the one to do it. Matching on the label rather than on the exit code is the
 * part that matters — a mutation that fails a suite for an unrelated reason
 * (an exception in setup, a neighbouring assertion) says nothing about whether
 * the behaviour is pinned.
 *
 * Three outcomes are failures of this gate:
 *
 *   SURVIVED    the suite passed with the fix reverted. The assertion that is
 *               supposed to cover it is tautological or absent.
 *   MISLABELLED the suite failed, but not at the named assertion. Either the
 *               mutation is broader than intended or the coverage is incidental.
 *   NOT APPLIED the search string is not in the built output any more. The code
 *               moved and this entry is stale — which is the failure mode that
 *               rots a hand-run mutation list into decoration.
 *
 * Run: bun run test:mutation      (opt-in — NOT part of `bun test`)
 *      bun scripts/mutation-gate.mjs --list
 *      bun scripts/mutation-gate.mjs --only beta
 *
 * ── Why it never touches the real dist ──
 * `dist/` is a symlink to a build directory shared with a running service and
 * with whatever else is running the suite right now. Mutating it in place would
 * be visible to all of them, and a crash between mutate and restore would leave
 * sabotaged code behind.
 *
 * Suites import their subject as `'../dist/pool.js'` — resolved relative to the
 * suite file, and Bun resolves through symlinks, so pointing a suite at a
 * different build means moving the suite. There is no import-specifier or
 * NODE_PATH seam to hook: the specifier is a relative path, not a bare one.
 * So the harness copies `dist/`, `test/` and `scripts/` into a scratch root and
 * runs the suite from there. `../dist` then lands on the copy by construction —
 * no rewriting, no runtime flags, and the real tree is opened read-only.
 */
import { spawn } from 'node:child_process';
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = realpathSync(join(import.meta.dirname, '..'));

// ── The mutations ────────────────────────────────────────────────────
// `find` must match EXACTLY ONCE in the built file; anything else is reported
// rather than guessed at. `expect` is a substring of the assertion label the
// suite prints on the ❌ line, or an array of them when one revert is claimed
// by more than one named assertion — then EVERY one of them has to go red, so
// a mutation cannot be credited to a label that stayed green.
const MUTATIONS = [
  {
    id: 'identity-headers-accept-forgery',
    why: 'hasCCIdentityHeaders stops checking the user-agent, so any client sending x-app: cli reads as CC',
    file: 'cc-template.js',
    find: String.raw`    return /^claude-cli\/\d+\.\d+\.\d+ \(external, [^)]+\)$/.test(get('user-agent'))
        && get('x-app') === 'cli';`,
    replace: `    return get('x-app') === 'cli';`,
    suite: 'cc-wire-fidelity.mjs',
    expect: "a wrapper's own user-agent is rejected",
  },
  {
    id: 'quota-probe-ignores-headers',
    why: 'isGenuineCCClient drops the header fallback, so the systemless quota probe collects the full template again',
    file: 'cc-template.js',
    find: `    if (sys === undefined)
        return headers ? hasCCIdentityHeaders(headers) : false;`,
    replace: `    if (sys === undefined)
        return false;`,
    suite: 'cc-wire-fidelity.mjs',
    expect: 'the quota probe needs its headers to be recognised',
  },
  {
    id: 'opener-allowlist-reintroduced',
    why: "isGenuineCCClient goes back to enumerating CC's system prompts, so every sub-agent rides the template path",
    file: 'cc-template.js',
    find: `    const second = sys[1];
    if (typeof second?.text !== 'string')
        return false;
    return detectTextToolClient(second.text) === null;`,
    replace: `    const second = sys[1];
    if (typeof second?.text !== 'string')
        return false;
    if (!second.text.startsWith('You are Claude Code'))
        return false;
    return detectTextToolClient(second.text) === null;`,
    suite: 'cc-client-fidelity.mjs',
    expect: 'custom sub-agent definition',
  },
  {
    id: 'billing-block-overwritten',
    why: "the genuine-CC branch stamps dario's billing tag over system[0] again, so the body's entrypoint contradicts the forwarded user-agent",
    file: 'cc-template.js',
    find: `        if (Array.isArray(clientSystem)) {
            body.system = clientSystem.map((b) => retagCacheControl(b, cacheControl));
        }`,
    replace: `        if (Array.isArray(clientSystem)) {
            body.system = clientSystem.map((b) => retagCacheControl(b, cacheControl));
            body.system[0] = { ...body.system[0], text: billingTag };
        }`,
    suite: 'cc-wire-fidelity.mjs',
    expect: 'system identical, billing block included',
  },
  {
    id: 'metadata-not-dario-owned',
    why: "the genuine-CC branch forwards the client's metadata.user_id, so the billed account is not the one dario leased",
    file: 'cc-template.js',
    find: `        body.metadata = {
            user_id: JSON.stringify({
                device_id: identity.deviceId,
                account_uuid: identity.accountUuid,
                session_id: identity.sessionId,
            }),
        };
        return { body, toolMap: new Map(), unmappedTools: [], unreachableTools: [], genuineCC: true };`,
    replace: `        return { body, toolMap: new Map(), unmappedTools: [], unreachableTools: [], genuineCC: true };`,
    suite: 'cc-wire-fidelity.mjs',
    expect: "metadata.user_id is dario's",
  },
  {
    id: 'cache-breakpoints-restamped',
    why: 'retagCacheControl stamps every block instead of only the ones the client marked, moving CC\'s breakpoints and inventing new ones',
    file: 'cc-template.js',
    find: `function retagCacheControl(block, cacheControl) {
    if (!block.cache_control)
        return block;
    return { ...block, cache_control: cacheControl };
}`,
    replace: `function retagCacheControl(block, cacheControl) {
    return { ...block, cache_control: cacheControl };
}`,
    suite: 'cc-wire-fidelity.mjs',
    expect: 'conversation breakpoints stay exactly where CC put them',
  },
  {
    id: 'client-ttl-survives-restamp',
    why: "retagCacheControl merges the client's cache_control instead of replacing it, so an operator-forced TTL no longer normalises the budget",
    file: 'cc-template.js',
    find: `    if (!block.cache_control)
        return block;
    return { ...block, cache_control: cacheControl };`,
    replace: `    if (!block.cache_control)
        return block;
    return { ...block, cache_control: { ...block.cache_control, ...cacheControl } };`,
    suite: 'cc-passthrough.mjs',
    expect: 'client ttl stripped',
  },
  {
    id: 'top-level-key-order-moved',
    why: 'the genuine-CC branch rebuilds the body with system hoisted first, so the top-level key order stops being the client\'s',
    file: 'cc-template.js',
    find: `        const clientSystem = clientBody.system;
        const body = { ...clientBody };`,
    replace: `        const clientSystem = clientBody.system;
        const body = { system: clientBody.system, ...clientBody };`,
    suite: 'cc-passthrough.mjs',
    expect: 'top-level key order preserved',
  },
  {
    id: 'dedupe-beta-flags-noop',
    why: 'dedupeBetaFlags returns its input, so the count_tokens path emits oauth-2025-04-20 twice again',
    file: 'proxy.js',
    find: `        seen.add(f);
        out.push(f);
    }
    return out.join(',');`,
    replace: `        seen.add(f);
        out.push(f);
    }
    return beta;`,
    suite: 'cc-wire-fidelity.mjs',
    expect: 'dedupeBetaFlags keeps first position, never sorts',
  },
  {
    id: 'error-type-constant',
    why: 'anthropicErrorType answers every status with one type, so a client switching on error.type switches on nothing',
    file: 'proxy.js',
    find: `export function anthropicErrorType(status) {
    switch (status) {`,
    replace: `export function anthropicErrorType(status) {
    if (status >= 0)
        return 'invalid_request_error';
    switch (status) {`,
    suite: 'cc-wire-fidelity.mjs',
    expect: '401 → authentication_error',
  },
  {
    id: 'request-id-not-unique',
    why: 'anthropicErrorBody hands out one request_id forever, so two bug reports quote the same id',
    file: 'proxy.js',
    find: '        request_id: requestId ?? `req_dario_${randomUUID().replace(/-/g, \'\')}`,',
    replace: "        request_id: requestId ?? 'req_dario_00000000000000000000000000000000',",
    suite: 'cc-wire-fidelity.mjs',
    expect: 'two errors do not share a request_id',
  },
  {
    id: 'x-should-retry-dropped',
    why: 'isForwardableUpstreamHeader stops forwarding x-should-retry, so CC guesses on exactly the responses the header arbitrates',
    file: 'proxy.js',
    find: `        || key === 'x-should-retry'`,
    replace: `        || key === 'x-should-retry-not-really'`,
    suite: 'cc-wire-fidelity.mjs',
    expect: 'forwards x-should-retry',
  },
  {
    id: 'api-hello-guessed-body',
    why: "/api/hello answers the guessed {\"message\":\"Hello, world!\"} instead of the recorded {\"message\":\"hello\"}",
    file: 'proxy.js',
    find: `            const body = JSON.stringify({ message: 'hello' });`,
    replace: `            const body = JSON.stringify({ message: 'Hello, world!' });`,
    suite: 'cc-wire-fidelity.mjs',
    expect: 'GET /api/hello body matches api.anthropic.com byte for byte',
  },
  {
    id: 'beta-rebuilt-not-forwarded',
    why: "genuine CC's own anthropic-beta list is thrown away and rebuilt from the template's per-model transform",
    file: 'proxy.js',
    find: `            else if (genuineCCRequest && clientBeta) {`,
    replace: `            else if (false && genuineCCRequest && clientBeta) {`,
    suite: 'cc-wire-fidelity.mjs',
    expect: 'anthropic-beta forwarded verbatim, order included',
  },
  {
    id: 'context-1m-not-added',
    why: "the [1m] suffix stops adding context-1m, so a CC pointed at claude-opus-5[1m] asks for the 1M window without the flag that enables it",
    file: 'proxy.js',
    find: `                if (/\\[1m\\]$/i.test(requestModel) && !beta.split(',').includes(CONTEXT_1M_BETA)) {
                    beta = insertBetaAfter(beta.split(','), CONTEXT_1M_BETA, CLAUDE_CODE_BETA).join(',');
                }`,
    replace: `                /* [1m] no longer adds the enabling flag */`,
    suite: 'cc-wire-fidelity.mjs',
    expect: 'a [1m] model gets context-1m added to the forwarded list',
  },
  {
    id: 'client-request-id-synthesised',
    why: 'x-client-request-id is invented on every request again, and recorded CC 2.1.236 sends it on none',
    file: 'proxy.js',
    find: `            else if (!clientOwnsItsHeaders) {
                headers['x-client-request-id'] = randomUUID();
            }`,
    replace: `            else {
                headers['x-client-request-id'] = randomUUID();
            }`,
    suite: 'cc-wire-fidelity.mjs',
    expect: 'x-client-request-id not invented',
  },
  {
    id: 'omitted-headers-filled-in',
    why: "the template fills in headers the client deliberately omitted, so count_tokens grows an x-stainless-timeout CC does not send there",
    file: 'proxy.js',
    find: `const OMISSION_SIGNIFICANT_HEADERS = new Set(['x-stainless-timeout', 'x-client-request-id']);`,
    replace: `const OMISSION_SIGNIFICANT_HEADERS = new Set([]);`,
    suite: 'cc-wire-fidelity.mjs',
    expect: 'count_tokens does not grow x-stainless-timeout',
  },
  {
    id: 'count-tokens-identity-dropped',
    why: "count_tokens stops forwarding CC's identity headers, so the endpoint that answers \"how big is my prompt\" goes out wearing the template's user-agent",
    file: 'proxy.js',
    find: `            const forwardedIdentity = (passthrough || genuineCCRequest || (isCountTokens && ccIdentityHeaders))
                ? forwardClientCCIdentityHeaders(req.headers)
                : {};`,
    replace: `            const forwardedIdentity = (passthrough || genuineCCRequest)
                ? forwardClientCCIdentityHeaders(req.headers)
                : {};`,
    suite: 'cc-wire-fidelity.mjs',
    expect: "count_tokens forwards CC's own user-agent",
  },
  {
    // Deliberately narrower than quota-probe-ignores-headers: that one takes the
    // header fallback away from every caller at once. This one leaves the
    // predicate alone and only stops sanitizeMessages consulting it, which is
    // the exact shape of the bug — a body with no system block reads as foreign,
    // and the scrub's trailing trim takes a newline off the prompt whose size is
    // the entire answer being asked for.
    id: 'counted-prompt-gets-scrubbed',
    why: "sanitizeMessages stops reading the request headers, so a systemless count_tokens body looks foreign and its trailing newline is trimmed off the prompt being measured",
    file: 'proxy.js',
    find: `    if (isGenuineCCClient(body, clientHeaders))
        return;`,
    replace: `    if (isGenuineCCClient(body))
        return;`,
    suite: 'cc-wire-fidelity.mjs',
    expect: 'the prompt being counted is not edited on the way',
  },
  {
    id: 'error-request-id-frozen',
    why: "sendError mints its request_id once per process again, so every 401 a process serves quotes the same id and two failures cannot be told apart",
    file: 'proxy.js',
    find: `    function sendError(res, status, message, extra) {
        const requestId = \`req_dario_\${randomUUID().replace(/-/g, '')}\`;`,
    replace: `    const frozenRequestId = \`req_dario_\${randomUUID().replace(/-/g, '')}\`;
    function sendError(res, status, message, extra) {
        const requestId = frozenRequestId;`,
    suite: 'cc-wire-fidelity.mjs',
    expect: 'a second error mints a fresh request_id, not a per-process constant',
  },
  {
    id: 'error-request-id-header-dropped',
    why: "the request-id response header goes away and the id stays body-only, which is the half the official SDK never reads (core/error.js takes requestID off the header)",
    file: 'proxy.js',
    find: `        res.writeHead(status, { ...JSON_HEADERS, ...CORS_RESPONSE_HEADERS, 'request-id': requestId, ...extra });`,
    replace: `        res.writeHead(status, { ...JSON_HEADERS, ...CORS_RESPONSE_HEADERS, ...extra });`,
    suite: 'cc-wire-fidelity.mjs',
    expect: 'sends a request-id header matching the body',
  },
  {
    id: 'unknown-path-403-again',
    why: "an unknown path answers 403 permission_error again instead of the 404 not_found_error api.anthropic.com answers",
    file: 'proxy.js',
    find: `            sendError(res, 404, MSG_NOT_FOUND);`,
    replace: `            sendError(res, 403, 'Path not allowed');`,
    suite: 'cc-wire-fidelity.mjs',
    expect: 'GET /v1/nope → 404 with an Anthropic-shaped body',
  },
  {
    id: 'server-tools-back-through-mapper',
    // Only the three that actually collided are let back in. The other four
    // server tools survived the old code by accident — their names are simply
    // absent from TOOL_MAP — so mutating the whole filter would prove less than
    // this does about which half of the split is load-bearing.
    why: "web_search, web_fetch and bash fall back through the name mapper, which is what turned them into WebSearch/WebFetch/Bash and grew the advertise array from 1 to 33",
    file: 'cc-template.js',
    find: `    const serverTools = declaredTools?.filter((t) => typeof t.type === 'string') ?? [];`,
    replace: `    const serverTools = declaredTools?.filter((t) => typeof t.type === 'string'
        && !['web_search', 'web_fetch', 'bash'].includes(t.name)) ?? [];`,
    suite: 'cc-request-kinds.mjs',
    expect: [
      'web_search: forwarded verbatim with its type intact',
      'web_search: not rewritten into a client tool',
      'bash: forwarded verbatim with its type intact',
    ],
  },
];

// ── CLI ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

if (flag('--list')) {
  for (const m of MUTATIONS) {
    const want = Array.isArray(m.expect) ? m.expect : [m.expect];
    console.log(`${m.id.padEnd(32)} ${m.suite.padEnd(24)} ${want.join('\n' + ' '.repeat(58))}`);
  }
  process.exit(0);
}

const only = opt('--only', null);
const selected = only ? MUTATIONS.filter((m) => m.id.includes(only) || m.suite.includes(only)) : MUTATIONS;
if (selected.length === 0) {
  console.error(`--only ${only} matched no mutation. --list to see them.`);
  process.exit(2);
}
const KEEP = flag('--keep');
const TIMEOUT_MS = Number(opt('--timeout-ms', '180000'));

// ── Scratch root ─────────────────────────────────────────────────────
// dereference:true on dist because it is a symlink to the shared build dir;
// we want the bytes here, not another pointer at them.
const root = mkdtempSync(join(tmpdir(), 'dario-mutation-'));
console.log(`scratch root: ${root}`);
cpSync(join(REPO, 'dist'), join(root, 'dist'), { recursive: true, dereference: true });
cpSync(join(REPO, 'test'), join(root, 'test'), { recursive: true });
cpSync(join(REPO, 'scripts'), join(root, 'scripts'), { recursive: true });
for (const f of ['package.json', 'tsconfig.json']) cpSync(join(REPO, f), join(root, f));
try { symlinkSync(realpathSync(join(REPO, 'node_modules')), join(root, 'node_modules')); } catch { /* absent is fine */ }

// The same live-template cache all.test.mjs hands every child, derived from the
// COPY so a mutation reaching cc-template-data.json is reflected in it. A suite
// run against a different template configuration than the runner uses is a
// suite whose mutation result does not transfer. Optional so this gate still
// runs on a checkout that predates the helper.
const cachePath = join(root, 'cc-template.live.json');
try {
  const { writeHeadlessLiveCache } = await import('../test/lib/headless-live-cache.mjs');
  writeHeadlessLiveCache(cachePath, join(root, 'dist', 'cc-template-data.json'));
} catch {
  console.log('  (no headless-live-cache helper — suites will fall back to the bundled template)');
}

// Pristine text of every file a mutation touches, read once. Restoring from
// this rather than re-copying keeps each run independent of the previous one
// even if a mutation somehow half-applies.
const pristine = new Map();
for (const m of new Set(selected.map((s) => s.file))) {
  pristine.set(m, readFileSync(join(root, 'dist', m), 'utf8'));
}
const restore = () => {
  for (const [file, text] of pristine) writeFileSync(join(root, 'dist', file), text);
};

let homeSeq = 0;
function runSuite(suite) {
  // A HOME of its own per run: several of these suites write ~/.dario, and the
  // operator's must never be one of them.
  const home = join(root, 'homes', `h${homeSeq++}`);
  mkdirSync(home, { recursive: true });
  return new Promise((resolve) => {
    const proc = spawn('bun', [join(root, 'test', suite)], {
      cwd: root,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        DARIO_IGNORE_CC_CREDENTIALS: '1',
        DARIO_LIVE_TEMPLATE_CACHE: cachePath,
      },
    });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
    }, TIMEOUT_MS);
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 'timeout' : code, out });
    });
  });
}

/** Assertion labels the suite printed on a ❌ line. */
function failedLabels(out) {
  return [...out.matchAll(/^\s*❌ (.+?)\s*$/gm)].map((m) => m[1]);
}

/** Every label this mutation claims. `expect` is one string or several. */
function expectsOf(m) {
  return Array.isArray(m.expect) ? m.expect : [m.expect];
}

// ── Baseline ─────────────────────────────────────────────────────────
// A mutation result only means something against a suite that is green to
// begin with. A red baseline (a stale dist, another lane mid-build) would make
// every mutation look "caught" for the wrong reason.
console.log('\nbaseline (unmutated copy):');
const baselineBad = [];
for (const suite of new Set(selected.map((s) => s.suite))) {
  const r = await runSuite(suite);
  const ok = r.code === 0;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${suite}`);
  if (!ok) {
    baselineBad.push(suite);
    console.log(r.out.split('\n').slice(-25).map((l) => `        ${l}`).join('\n'));
  }
}
if (baselineBad.length > 0) {
  console.error(`\nbaseline is red (${baselineBad.join(', ')}) — mutation results would be meaningless.`);
  console.error('Rebuild dist, or run with --only to skip the affected suites.');
  if (!KEEP) rmSync(root, { recursive: true, force: true });
  process.exit(2);
}

// ── Run ──────────────────────────────────────────────────────────────
const results = [];
for (const m of selected) {
  restore();
  const path = join(root, 'dist', m.file);
  const before = pristine.get(m.file);
  const hits = before.split(m.find).length - 1;
  if (hits !== 1) {
    results.push({ m, verdict: 'NOT APPLIED', detail: `search string matched ${hits} times in dist/${m.file} (want exactly 1)` });
    console.log(`\n[NOT APPLIED] ${m.id} — ${hits} matches in dist/${m.file}`);
    continue;
  }
  // Function form: a replacement carrying `$&` or `$1` would otherwise be
  // expanded rather than written literally.
  writeFileSync(path, before.replace(m.find, () => m.replace));

  const r = await runSuite(m.suite);
  restore();

  const labels = failedLabels(r.out);
  const wanted = expectsOf(m);
  const hits2 = wanted.map((w) => labels.find((l) => l.includes(w)));
  const missing = wanted.filter((w, i) => !hits2[i]);
  let verdict, detail;
  if (r.code === 0) {
    verdict = 'SURVIVED';
    detail = `${m.suite} still passed with the fix reverted`;
  } else if (missing.length === 0) {
    verdict = 'CAUGHT';
    const extra = labels.length - wanted.length;
    detail = hits2.map((l) => `❌ ${l}`).join('; ') + (extra > 0 ? ` (+${extra} more)` : '');
  } else if (r.code === 'timeout') {
    verdict = 'MISLABELLED';
    detail = `${m.suite} timed out rather than failing an assertion`;
  } else if (hits2.some(Boolean)) {
    verdict = 'MISLABELLED';
    detail = `only ${wanted.length - missing.length}/${wanted.length} of the named assertions went red; still green: ${missing.map((w) => JSON.stringify(w)).join(', ')}`;
  } else {
    verdict = 'MISLABELLED';
    detail = labels.length
      ? `failed at ${labels.length} other assertion(s): ${labels.slice(0, 4).map((l) => JSON.stringify(l)).join(', ')}`
      : `exited ${r.code} without printing a failing assertion (crash in setup?)`;
  }
  results.push({ m, verdict, detail, out: verdict === 'CAUGHT' ? '' : r.out });
  console.log(`\n[${verdict}] ${m.id}`);
  console.log(`   revert: ${m.why}`);
  console.log(`   suite:  ${m.suite}`);
  console.log(`   want:   ${wanted.map((w) => `❌ …${w}…`).join('\n           ')}`);
  console.log(`   got:    ${detail}`);
}

restore();
if (!KEEP) rmSync(root, { recursive: true, force: true });
else console.log(`\nscratch root kept at ${root}`);

// ── Report ───────────────────────────────────────────────────────────
const caught = results.filter((r) => r.verdict === 'CAUGHT');
const bad = results.filter((r) => r.verdict !== 'CAUGHT');
console.log(`\n${'='.repeat(70)}`);
console.log(`  ${caught.length}/${results.length} mutations caught by the assertion that claims them`);
console.log(`${'='.repeat(70)}`);
for (const r of bad) {
  console.log(`  ${r.verdict.padEnd(12)} ${r.m.id} → ${r.m.suite}`);
  console.log(`               ${r.detail}`);
  if (r.out) {
    const tail = r.out.split('\n').filter((l) => l.includes('❌') || /Error|error:/.test(l)).slice(0, 8);
    if (tail.length) console.log(tail.map((l) => `               ${l.trim()}`).join('\n'));
  }
}
if (bad.length === 0) console.log('  every mutation went red at its named assertion.');
process.exit(bad.length === 0 ? 0 : 1);
