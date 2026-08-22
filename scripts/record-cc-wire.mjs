#!/usr/bin/env bun
/**
 * Record real Claude Code traffic to api.anthropic.com.
 *
 * dario's whole job is to be indistinguishable from Claude Code on the wire, so
 * the only evidence that settles a fidelity question is what CC actually sent.
 * Every other CC-shape assertion in this repo is somebody's reading of the
 * bundle; this script produces the thing those assertions are checked against.
 *
 * Differences from the re-record path inside test/cc-wire-fidelity.mjs, which
 * this supersedes for corpus-building:
 *
 *   - It STREAMS the upstream response through instead of buffering it with
 *     `await up.arrayBuffer()`. A buffered proxy is invisible to `claude -p`,
 *     which only reads the final result, and fatal to an interactive session,
 *     which renders tokens as they arrive and times out waiting for a body that
 *     only lands when the turn is over.
 *   - It records RESPONSES as well as requests, SSE frames included, because
 *     half the fidelity questions (does upstream send a message_stop after an
 *     error, which headers come back, what the ratelimit block looks like) are
 *     answerable only from the downstream side.
 *   - It drives an INTERACTIVE CC under tmux, not just `-p`. Headless announces
 *     `cc_entrypoint=sdk-cli` and a different beta list on an identically shaped
 *     body, so a corpus built from `-p` alone mislabels every interactive shape
 *     it claims to cover.
 *
 * Credentials: the sandbox gets a COPY of ~/.claude/.credentials.json, so the
 * recorded traffic is real subscription traffic. Everything else about the
 * sandbox is throwaway — its own HOME, its own CLAUDE_CONFIG_DIR, its own cwd —
 * because a settings.json `env` block outranks the environment handed to a
 * spawned child, and pointing ANTHROPIC_BASE_URL at a recorder without also
 * relocating CLAUDE_CONFIG_DIR is silently defeated (dario#872, 72adbac).
 *
 * Output is RAW and unscrubbed: it contains whatever was typed at the session.
 * It is written under --out (default ~/.dario/cc-wire-raw) and is not for
 * committing. scripts/shape-cc-wire.mjs turns a raw run into a fixture corpus.
 *
 *   bun scripts/record-cc-wire.mjs --headless --model claude-sonnet-5
 *   bun scripts/record-cc-wire.mjs --interactive --send '/compact'
 */
import { createServer } from 'node:http';
import { gunzipSync, inflateSync, brotliDecompressSync, zstdDecompressSync } from 'node:zlib';
import { request as httpsRequest } from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, copyFileSync, appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : (args[i + 1]?.startsWith('--') ? true : args[i + 1]);
};
const has = (name) => args.includes(`--${name}`);

const MODE = has('interactive') ? 'interactive' : 'headless';
const MODEL = flag('model', 'claude-sonnet-5');
const PROMPT = flag('prompt', 'Say PONG and nothing else.');
const SENDS = args.reduce((acc, a, i) => (a === '--send' ? [...acc, args[i + 1]] : acc), []);
const OUT_ROOT = flag('out', join(homedir(), '.dario', 'cc-wire-raw'));
const LABEL = flag('label', `${MODE}-${MODEL.replace(/[^a-z0-9]+/gi, '-')}`);
const IDLE_MS = Number(flag('idle', '25000'));
const MAX_MS = Number(flag('max', '240000'));

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(OUT_ROOT, `${stamp}-${LABEL}`);
mkdirSync(OUT, { recursive: true });
const LOG = join(OUT, 'wire.ndjson');

let seq = 0;
let lastActivity = Date.now();
const summary = [];

/**
 * One record per exchange, appended as it completes. Append rather than collect:
 * an interactive session is killed rather than exited, and a run that is killed
 * mid-turn must still leave every completed exchange on disk.
 */
function emit(rec) {
  appendFileSync(LOG, JSON.stringify(rec) + '\n');
  summary.push({ n: rec.n, method: rec.request.method, path: rec.request.path.split('?')[0], status: rec.response.status, ms: rec.ms, kind: rec.kind });
}

/** What kind of CC request this is, read off the body rather than guessed. */
function classify(body) {
  if (!body || typeof body !== 'object') return 'non-json';
  const sys = JSON.stringify(body.system ?? '');
  const ep = /cc_entrypoint=([a-z-]+)/.exec(sys)?.[1];
  const hash = /cc_[a-z_]*hash=([a-z0-9]+)/.exec(sys)?.[1];
  if (body.max_tokens === 1) return 'quota-probe';
  if (!body.system) return 'no-system';
  if (body.output_config) return 'structured-output';
  if (/cc_is_subagent=true/.test(sys)) return `subagent:${ep ?? '?'}`;
  return `main:${ep ?? '?'}${hash ? `:${hash}` : ''}`;
}

const rec = createServer((req, res) => {
  const n = ++seq;
  const started = Date.now();
  lastActivity = started;
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const reqBody = Buffer.concat(chunks);
    const headers = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];
    delete headers.connection;

    const up = httpsRequest({
      host: 'api.anthropic.com',
      path: req.url,
      method: req.method,
      headers: { ...headers, host: 'api.anthropic.com' },
    }, (upRes) => {
      // Head the downstream response BEFORE any body arrives, so the client
      // sees exactly the latency it would have seen talking to Anthropic.
      res.writeHead(upRes.statusCode, upRes.headers);
      const outChunks = [];
      upRes.on('data', (c) => { outChunks.push(c); lastActivity = Date.now(); res.write(c); });
      upRes.on('end', () => {
        res.end();
        // Decode for the RECORD only; the client already got the bytes verbatim
        // above. An undecoded body reads as mojibake, which is how a 429's
        // error envelope — the one thing a rate-limit capture exists for —
        // came back as a wall of replacement characters.
        const rawBuf = Buffer.concat(outChunks);
        const enc = String(upRes.headers['content-encoding'] ?? '').toLowerCase();
        let decoded = rawBuf;
        try {
          if (enc === 'gzip') decoded = gunzipSync(rawBuf);
          else if (enc === 'deflate') decoded = inflateSync(rawBuf);
          else if (enc === 'br') decoded = brotliDecompressSync(rawBuf);
          else if (enc === 'zstd' && typeof zstdDecompressSync === 'function') decoded = zstdDecompressSync(rawBuf);
        } catch { /* keep the bytes as they came */ }
        const raw = decoded.toString('utf8');
        let parsedBody = null;
        let sse = null;
        const ct = String(upRes.headers['content-type'] ?? '');
        if (ct.includes('event-stream')) {
          // Keep the frames, in order, with their event names. The order and the
          // presence/absence of a terminal frame is the whole question in the
          // truncation work; a concatenated blob answers neither.
          sse = raw.split('\n\n').filter((b) => b.trim()).map((block) => {
            const ev = /^event: (.+)$/m.exec(block)?.[1] ?? null;
            const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('');
            let json = null;
            try { json = JSON.parse(data); } catch { /* keep raw */ }
            return { event: ev, data: json ?? data };
          });
        } else {
          try { parsedBody = JSON.parse(raw); } catch { parsedBody = raw.slice(0, 20_000); }
        }
        let reqJson = null;
        try { reqJson = JSON.parse(reqBody.toString('utf8') || 'null'); } catch { /* keep null */ }
        const kind = req.url.startsWith('/v1/messages') && req.method === 'POST' ? classify(reqJson) : req.url.split('?')[0];
        emit({
          n, kind, ms: Date.now() - started,
          request: {
            method: req.method,
            path: req.url,
            // rawHeaders preserves order and duplicates; the flattened map does
            // not, and header ORDER is one of the things dario has to reproduce.
            rawHeaders: req.rawHeaders,
            headers,
            bodyKeyOrder: reqJson && typeof reqJson === 'object' ? Object.keys(reqJson) : null,
            body: reqJson,
            bodyBytes: reqBody.length,
          },
          response: {
            status: upRes.statusCode,
            headers: upRes.headers,
            body: parsedBody,
            sse,
            sseFrameCount: sse?.length ?? null,
            bytes: raw.length,
          },
        });
        process.stdout.write(`  [${n}] ${req.method} ${req.url.split('?')[0]} → ${upRes.statusCode}  ${kind}  ${raw.length}B\n`);
      });
    });
    up.on('error', (err) => {
      emit({ n, kind: 'upstream-error', ms: Date.now() - started,
        request: { method: req.method, path: req.url, rawHeaders: req.rawHeaders, headers, body: null, bodyBytes: reqBody.length },
        response: { status: 0, headers: {}, body: String(err), sse: null, sseFrameCount: null, bytes: 0 } });
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(err) } }));
    });
    if (reqBody.length) up.write(reqBody);
    up.end();
  });
});

await new Promise((r) => rec.listen(0, '127.0.0.1', r));
const PORT = rec.address().port;

// ---- sandbox -------------------------------------------------------------
const HOME = join(OUT, 'home');
const CFG = join(HOME, '.claude');
mkdirSync(CFG, { recursive: true });
const realCreds = join(homedir(), '.claude', '.credentials.json');
if (!existsSync(realCreds)) {
  console.error(`no credentials at ${realCreds} — cannot record real traffic`);
  process.exit(1);
}
copyFileSync(realCreds, join(CFG, '.credentials.json'));
writeFileSync(join(CFG, 'settings.json'), '{}\n');
// Onboarding state, minus anything about the operator's real projects. Without
// it an interactive CC opens the login picker and the session never sends.
// Everything except the operator's own project list and scrollback. A
// hand-built `{hasCompletedOnboarding:true}` is NOT enough: an interactive CC
// with valid credentials still opened the OAuth login flow, while headless `-p`
// on the same sandbox authenticated fine. The interactive path checks more of
// this file than the SDK path does, so the honest move is to carry all of it
// and drop only what is bulky or none of the recorder's business.
// `mcpServers` too: the operator's MCP servers are real tools CC declares, so
// leaving them in makes the recorded tool list 63 entries of which 38 are this
// machine's, and a corpus built from that cannot answer "which tools does CC
// itself send". Record them deliberately with --keep-mcp when that IS the
// question.
const DROP_KEYS = new Set(['projects', 'history', 'tipsHistory', 'cachedChangelog',
  ...(has('keep-mcp') ? [] : ['mcpServers'])]);
const realDotClaude = join(homedir(), '.claude.json');
let onboarding = { hasCompletedOnboarding: true };
if (existsSync(realDotClaude)) {
  try {
    const j = JSON.parse(readFileSync(realDotClaude, 'utf8'));
    onboarding = Object.fromEntries(Object.entries(j).filter(([k]) => !DROP_KEYS.has(k)));
    onboarding.hasCompletedOnboarding = true;
  } catch { /* defaults */ }
}
// Written to BOTH roots: CC reads `.claude.json` from CLAUDE_CONFIG_DIR when
// that is set, and from HOME when it is not, and which one wins has moved
// between releases. Writing both costs nothing and removes the guess.
writeFileSync(join(HOME, '.claude.json'), JSON.stringify(onboarding, null, 2));
writeFileSync(join(CFG, '.claude.json'), JSON.stringify(onboarding, null, 2));
// Off $HOME on purpose. CC walks UP from cwd collecting CLAUDE.md files, so a
// work dir under the operator's home inherits their instruction files and stops
// on an "allow external imports?" gate that has nothing to do with the wire.
const WORK = mkdtempSync(join(tmpdir(), 'dario-wire-work-'));
spawnSync('git', ['init', '-q'], { cwd: WORK });
writeFileSync(join(WORK, 'README.md'), 'wire recording sandbox\n');
// --seed-agent <file.md> plants a sub-agent definition in the sandbox. The
// question it exists to answer is where CC puts an OPERATOR-authored prompt in
// the system array, which decides whether isGenuineCCClient can be fooled by
// what a user wrote in ~/.claude/agents. Guessing at that from CC's own agents
// is not evidence: they are all written by Anthropic.
for (const src of args.reduce((acc, a, i) => (a === '--seed-agent' ? [...acc, args[i + 1]] : acc), [])) {
  mkdirSync(join(CFG, 'agents'), { recursive: true });
  copyFileSync(src, join(CFG, 'agents', src.split('/').pop()));
}

const childEnv = {
  HOME, PATH: process.env.PATH, TERM: MODE === 'interactive' ? 'xterm-256color' : 'dumb',
  LANG: process.env.LANG ?? 'C.UTF-8',
  CLAUDE_CONFIG_DIR: CFG,
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}`,
};

console.log(`recording → ${OUT}`);
console.log(`  mode ${MODE}  model ${MODEL}  recorder 127.0.0.1:${PORT}`);

const idleWatch = async () => {
  const deadline = Date.now() + MAX_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    if (seq > 0 && Date.now() - lastActivity > IDLE_MS) return 'idle';
  }
  return 'max';
};

if (MODE === 'headless') {
  await new Promise((resolve) => {
    const cp = spawn('claude', ['-p', PROMPT, '--model', MODEL], {
      cwd: WORK, env: childEnv, stdio: 'ignore',
    });
    cp.on('exit', resolve);
    setTimeout(() => { try { cp.kill('SIGKILL'); } catch {} resolve(); }, MAX_MS);
  });
  // The title generator and count_tokens can land after the main turn returns.
  await new Promise((r) => setTimeout(r, 3000));
} else {
  const SESSION = `dario-wire-${process.pid}`;
  const env = Object.entries(childEnv).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
  spawnSync('tmux', ['kill-session', '-t', SESSION], { stdio: 'ignore' });
  spawnSync('tmux', ['new-session', '-d', '-s', SESSION, '-x', '200', '-y', '50',
    'sh', '-c', `cd ${JSON.stringify(WORK)} && env ${env} claude --model ${MODEL}`]);
  const send = (keys) => spawnSync('tmux', ['send-keys', '-t', SESSION, ...keys]);
  const capture = () => spawnSync('tmux', ['capture-pane', '-p', '-t', SESSION], { encoding: 'utf8' }).stdout ?? '';
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();

  // Snapshot the pane continuously. A session that dies, or stops on a prompt
  // nobody anticipated, leaves no other evidence: the final capture-pane runs
  // after the session is gone and returns an empty string, which reads exactly
  // like a session that ran and printed nothing.
  const paneLog = join(OUT, 'pane.log');
  const snap = setInterval(() => {
    const pane = capture();
    if (pane.trim()) appendFileSync(paneLog, `\n===== +${Math.round((Date.now() - t0) / 1000)}s =====\n${pane}`);
  }, 2000);

  await wait(8000);
  // Whatever gate this build puts in front of a fresh cwd. Answering by regex
  // rather than blind Enter, because a blind Enter on the login picker starts
  // an OAuth flow that then eats the real prompt.
  for (let i = 0; i < 12; i++) {
    const pane = capture();
    if (/Paste code here|Select login method|Log in with/i.test(pane)) {
      clearInterval(snap);
      console.error('\nCC opened its LOGIN flow — the sandbox was not accepted as authenticated.');
      console.error(`pane: ${paneLog}`);
      spawnSync('tmux', ['kill-session', '-t', SESSION], { stdio: 'ignore' });
      rec.close();
      process.exit(3);
    }
    // Any numbered confirm gate: trust-this-folder, allow-external-imports,
    // whatever the next release adds. They all render the same footer and they
    // all default to the permissive first option, which is what a recording
    // needs. Matching the FOOTER rather than each prompt's wording means a new
    // gate does not silently stall the session the way the external-imports one
    // did — that cost a run that looked like "CC printed nothing".
    if (/Enter to confirm/i.test(pane)) { send(['Enter']); await wait(2500); continue; }
    break;
  }
  for (const line of (SENDS.length ? SENDS : [PROMPT])) {
    send([line]);
    await wait(400);
    send(['Enter']);
    // Let the turn run to completion before typing the next one.
    const until = Date.now() + 90_000;
    let quietSince = Date.now();
    while (Date.now() < until) {
      await wait(1000);
      if (Date.now() - lastActivity > 6000 && Date.now() - quietSince > 6000) break;
      if (Date.now() - lastActivity < 6000) quietSince = Date.now();
    }
  }
  writeFileSync(join(OUT, 'pane.txt'), capture());
  clearInterval(snap);
  await idleWatch();
  spawnSync('tmux', ['kill-session', '-t', SESSION], { stdio: 'ignore' });
}

rec.close();
const ccVersion = (() => {
  for (const line of readFileSync(LOG, 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line);
    const ua = r.request.headers['user-agent'];
    const m = /claude-cli\/([\d.]+)/.exec(ua ?? '');
    if (m) return m[1];
  }
  return null;
})();
writeFileSync(join(OUT, 'run.json'), JSON.stringify({
  mode: MODE, model: MODEL, ccVersion, recordedAt: new Date().toISOString(),
  exchanges: seq, sends: SENDS.length ? SENDS : [PROMPT], summary,
}, null, 2) + '\n');
// The sandbox HOME holds a copy of real credentials; it has served its purpose.
rmSync(HOME, { recursive: true, force: true });
rmSync(WORK, { recursive: true, force: true });
console.log(`\n${seq} exchange(s) from CC ${ccVersion ?? '?'} → ${LOG}`);
for (const s of summary) console.log(`  ${String(s.n).padStart(3)} ${s.method} ${s.path} ${s.status} ${s.kind}`);
