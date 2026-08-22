#!/usr/bin/env bun
/**
 * Turn a raw recording from scripts/record-cc-wire.mjs into a committable
 * fixture corpus.
 *
 * The raw run is real traffic: real prompts, real device and account ids, real
 * paths, the operator's own repository state. None of that can go in the repo,
 * and none of it is what the fixtures are for — every fidelity question is
 * about SHAPE. So each exchange is reduced to the shape and the identifying
 * values are replaced with stable placeholders rather than deleted, because a
 * missing field and a redacted field are different wire shapes and only one of
 * them is what CC sends.
 *
 *   bun scripts/shape-cc-wire.mjs <raw-run-dir> [more-dirs...] --out test/fixtures/cc-wire-2.1.239
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = outIdx === -1 ? null : args[outIdx + 1];
const DIRS = args.filter((a, i) => !a.startsWith('--') && i !== outIdx + 1);
if (!OUT || DIRS.length === 0) {
  console.error('usage: bun scripts/shape-cc-wire.mjs <raw-run-dir>... --out <fixture-dir>');
  process.exit(2);
}

const HOME = homedir();
const PLACEHOLDER = {
  device_id: '0'.repeat(64),
  account_uuid: '00000000-0000-4000-8000-000000000000',
  session_id: '11111111-1111-4111-8111-111111111111',
};

/** Every string leaf, with host and identity values replaced in place. */
function scrub(value) {
  if (typeof value === 'string') {
    let s = value;
    s = s.split(HOME).join('/home/user');
    s = s.replace(/req_[A-Za-z0-9]{10,}/g, 'req_00000000000000000000');
    s = s.replace(/\/tmp\/dario-wire-work-[A-Za-z0-9]+/g, '/tmp/work');
    s = s.replace(/\/tmp\/dario-live-cc-[A-Za-z0-9]+/g, '/tmp/work');
    s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, PLACEHOLDER.session_id);
    s = s.replace(/[0-9a-f]{64}/g, PLACEHOLDER.device_id);
    // x-claude-code-agent-id on a sub-agent dispatch: 17 hex, so neither the
    // uuid nor the 64-hex rule above sees it. Ephemeral rather than account-
    // scoped, but it is still an id off a real session and a fixture is a
    // public file. Length is shape and is preserved.
    s = s.replace(/\b[0-9a-f]{17}\b/g, 'a'.repeat(17));
    s = s.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, 'user@example.com');
    s = s.replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-REDACTED');
    s = s.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer REDACTED');
    return s;
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
  }
  return value;
}

/**
 * What a request kind IS, as a stable name. Keyed on the things that actually
 * distinguish a kind on the wire — entrypoint, top-level key order, whether a
 * schema is demanded, whether tools are declared — rather than on a guess from
 * the prompt text, which is the operator's and cannot appear in a fixture name.
 */
function kindOf(body) {
  if (!body || typeof body !== 'object') return 'non-json';
  const st = JSON.stringify(body.system ?? '');
  const ep = /cc_entrypoint=([a-z-]+)/.exec(st)?.[1] ?? 'none';
  if (body.max_tokens === 1 && !body.system) return 'quota-probe';
  if (body.output_config?.format?.type === 'json_schema') return `structured-output-${ep}`;
  if (/cc_is_subagent=true/.test(st)) return `subagent-${ep}`;
  const tools = (body.tools ?? []).length;
  if (tools === 0) return `no-tools-${ep}`;
  return `main-loop-${ep}`;
}

/** Everything about a message that is shape, and nothing that is content. */
function messageShape(m) {
  const content = m.content;
  if (typeof content === 'string') return { role: m.role, content: 'string', chars: content.length };
  if (!Array.isArray(content)) return { role: m.role, content: typeof content };
  return {
    role: m.role,
    blocks: content.map((b) => ({
      type: b.type,
      keys: Object.keys(b),
      ...(b.cache_control ? { cache_control: b.cache_control } : {}),
      ...(b.type === 'tool_result' && Array.isArray(b.content)
        // The one nesting that matters: an image arrives INSIDE a tool_result's
        // own content array, one level deeper than a walker of msg.content sees.
        ? { nested: b.content.map((n) => n.type) } : {}),
      ...(b.type === 'text' && typeof b.text === 'string' ? { chars: b.text.length } : {}),
    })),
  };
}

const captures = new Map();
let ccVersion = null;
let recordedAt = null;

for (const dir of DIRS) {
  const log = join(dir, 'wire.ndjson');
  if (!existsSync(log)) { console.error(`skip ${dir}: no wire.ndjson`); continue; }
  const run = existsSync(join(dir, 'run.json')) ? JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) : {};
  ccVersion ??= run.ccVersion;
  recordedAt ??= run.recordedAt;
  for (const line of readFileSync(log, 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line);
    const req = r.request;
    const body = req.body;
    const name = req.method === 'POST' ? kindOf(body) : `${req.method.toLowerCase()}${req.path.split('?')[0].replace(/\//g, '-')}`;
    // First of a kind wins. A later one is the same shape by construction, and
    // keeping one keeps the corpus readable.
    if (captures.has(name)) continue;
    const shaped = {
      name,
      recordedFrom: basename(dir),
      request: {
        method: req.method,
        path: req.path,
        headerOrder: req.rawHeaders.filter((_, i) => i % 2 === 0).map((h) => h.toLowerCase()),
        headers: scrub(req.headers),
        bodyKeyOrder: req.bodyKeyOrder,
        ...(body && typeof body === 'object' ? {
          model: body.model,
          max_tokens: body.max_tokens,
          stream: body.stream,
          thinking: body.thinking,
          context_management: body.context_management,
          output_config: body.output_config,
          metadata: scrub(body.metadata),
          systemBlocks: Array.isArray(body.system)
            ? body.system.map((b) => ({ type: b.type, keys: Object.keys(b), chars: (b.text ?? '').length, cache_control: b.cache_control ?? null,
                // The billing block is the one system block that is pure shape,
                // so it is kept whole: its component list and the per-prompt
                // hash are what identify an entrypoint.
                ...(String(b.text ?? '').startsWith('x-anthropic-billing-header') ? { text: scrub(b.text) } : {}),
                ...(String(b.text ?? '').startsWith('You are ') && (b.text ?? '').length < 200 ? { text: scrub(b.text) } : {}) }))
            : (body.system === undefined ? null : 'string'),
          toolNames: (body.tools ?? []).map((t) => t.name),
          toolCount: (body.tools ?? []).length,
          serverTools: (body.tools ?? []).filter((t) => t.type).map((t) => ({ type: t.type, name: t.name, keys: Object.keys(t) })),
          messages: (body.messages ?? []).map(messageShape),
        } : {}),
      },
      response: {
        status: r.response.status,
        headers: scrub(Object.fromEntries(Object.entries(r.response.headers)
          .filter(([k]) => !['set-cookie', 'cf-ray', 'date', 'request-id', 'x-request-id'].includes(k)))),
        sseEvents: r.response.sse ? r.response.sse.map((e) => e.event) : null,
        // The terminal frame is the whole question in the truncation work.
        sseLast: r.response.sse?.at(-1)?.event ?? null,
        body: r.response.sse ? null : scrub(r.response.body),
      },
    };
    captures.set(name, shaped);
  }
}

mkdirSync(OUT, { recursive: true });
for (const [name, cap] of captures) {
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(cap, null, 2) + '\n');
}
writeFileSync(join(OUT, 'index.json'), JSON.stringify({
  ccVersion, recordedAt: (recordedAt ?? '').slice(0, 10),
  how: 'MITM reverse proxy on ANTHROPIC_BASE_URL with real subscription credentials, sandboxed HOME + CLAUDE_CONFIG_DIR + off-$HOME cwd; interactive sessions driven under tmux. Recorded by scripts/record-cc-wire.mjs, shaped by scripts/shape-cc-wire.mjs.',
  scrubbed: 'device_id, account_uuid, session ids, request ids, absolute paths, email, tokens. Message and system-prompt CONTENT is reduced to block type + length; only the billing header and the short identity line are kept verbatim, because those are shape.',
  captures: [...captures.values()].map((c) => ({ name: c.name, file: `${c.name}.json`, method: c.request.method, path: c.request.path, status: c.response.status })),
}, null, 2) + '\n');
console.log(`${captures.size} shape(s) → ${OUT}`);
for (const n of captures.keys()) console.log(`  ${n}`);
