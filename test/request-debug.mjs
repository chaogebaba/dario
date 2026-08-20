import { rmSync } from 'node:fs';
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RequestDebugStore } from '../dist/request-debug.js';

let pass = 0;
let fail = 0;
function check(name, condition) {
  if (condition) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.error(`  FAIL ${name}`); }
}

const dir = await mkdtemp(join(tmpdir(), 'dario-debug-'));
// On exit, not after the last assertion: a failing check exits(1) below, which
// is exactly when the stranded dir is most likely.
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const file = join(dir, 'requests.ndjson');
const store = new RequestDebugStore({ maxEntries: 3, filePath: file });
await store.load();
for (let i = 1; i <= 4; i++) {
  store.add({
    ts: `2026-01-01T00:00:0${i}.000Z`, req: i, method: 'POST', path: '/v1/messages',
    model: 'claude-opus-5', account: 'seat', status: 200, latencyMs: i,
    upstreamAttempts: i === 3 ? 2 : 1, recoveryPasses: i === 3 ? 1 : 0,
    inputTokens: 10, outputTokens: 2, cacheReadTokens: 20, cacheCreateTokens: 3,
    inputPreview: `input-${i}`, outputPreview: `output-${i}`,
    inputChars: 7, outputChars: 8, inputTruncated: false, outputTruncated: false,
  });
}
await store.flush();
check('FIFO evicts oldest in memory', store.recent().map((e) => e.req).join(',') === '4,3,2');
check('capacity is reported', store.size() === 3 && store.maxEntries === 3);
const lines = (await readFile(file, 'utf8')).trim().split('\n');
// Steady state appends; it does not rewrite. The file is allowed to carry
// surplus lines beyond the in-memory window (bounded at COMPACT_FACTOR x
// maxEntries) and `load()` keeps only the newest maxEntries. A file pinned to
// exactly maxEntries lines would mean a full O(n) rewrite on every request,
// which is what this window size makes expensive.
check('surplus lines are appended, not rewritten away', lines.length === 4 && JSON.parse(lines[0]).req === 1);

const restored = new RequestDebugStore({ maxEntries: 3, filePath: file });
await restored.load();
check('recent entries survive restart', restored.recent().map((e) => e.req).join(',') === '4,3,2');
check('attempt diagnostics survive restart', restored.recent().find((e) => e.req === 3)?.upstreamAttempts === 2);
check('request previews survive restart', restored.recent()[0]?.inputPreview === 'input-4');
check('response previews survive restart', restored.recent()[0]?.outputPreview === 'output-4');
await chmod(file, 0o644);
const hardened = new RequestDebugStore({ maxEntries: 3, filePath: file });
await hardened.load();
check('existing debug file is hardened to owner-only', ((await stat(file)).mode & 0o077) === 0);

await writeFile(file, `${await readFile(file, 'utf8')}{"torn":`);
const repaired = new RequestDebugStore({ maxEntries: 3, filePath: file });
await repaired.load();
repaired.add({
  ts: '2026-01-01T00:00:05.000Z', req: 5, method: 'POST', path: '/v1/messages',
  model: 'claude-opus-5', initialAccount: 'seat', account: 'seat', status: 200,
  latencyMs: 1, upstreamAttempts: 1, recoveryPasses: 0, failoverCount: 0,
  retryReasons: [], inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0,
});
await repaired.flush();
const afterTorn = new RequestDebugStore({ maxEntries: 3, filePath: file });
await afterTorn.load();
check('torn final line is repaired before append', afterTorn.recent()[0]?.req === 5);

// ── Compaction bounds the surplus ──────────────────────────────────────────
// Appending forever would grow the file without limit, so the surplus is
// compacted back to the live window once it crosses COMPACT_FACTOR x
// maxEntries. The point of the scheme is that this costs one rewrite per
// maxEntries requests instead of one per request — so the file must be
// observed *growing* between compactions, then snapping back.
{
  const growFile = join(dir, 'grow.ndjson');
  const grow = new RequestDebugStore({ maxEntries: 4, filePath: growFile });
  await grow.load();
  const entry = (i) => ({
    ts: `2026-01-02T00:00:00.${String(i).padStart(3, '0')}Z`, req: i, method: 'POST',
    path: '/v1/messages', model: 'claude-opus-5', initialAccount: 'seat', account: 'seat',
    status: 200, latencyMs: 1, upstreamAttempts: 1, recoveryPasses: 0, failoverCount: 0,
    retryReasons: [], inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0,
  });
  const lineCount = async () => (await readFile(growFile, 'utf8')).trim().split('\n').length;

  // Flush per add so each append lands as its own write — the steady-state
  // shape. Batched adds coalesce, which would hide the growth.
  const counts = [];
  for (let i = 1; i <= 12; i++) { grow.add(entry(i)); await grow.flush(); counts.push(await lineCount()); }

  check('file grows past the in-memory window', Math.max(...counts) > 4);
  check('file never exceeds COMPACT_FACTOR x maxEntries', Math.max(...counts) <= 8);
  check('compaction actually fires', counts.some((n, i) => i > 0 && n < counts[i - 1]));
  check('in-memory window stays at capacity', grow.size() === 4);

  const reloaded = new RequestDebugStore({ maxEntries: 4, filePath: growFile });
  await reloaded.load();
  check('reload after compaction yields the newest window',
    reloaded.recent().map((e) => e.req).join(',') === '12,11,10,9');
}

// ── Oversized lines are capped on write ────────────────────────────────────
// `load()` sizes its read window as maxEntries * MAX_LINE_BYTES, so a line that
// overruns that bound silently pushes older entries out of the window. JSON
// escaping is the reason the per-field character caps aren't sufficient on
// their own: a preview of control characters encodes to 6 bytes per source
// char, inflating a nominally 8 KiB field past 32 KiB.
{
  const bigFile = join(dir, 'big.ndjson');
  const big = new RequestDebugStore({ maxEntries: 4, filePath: bigFile });
  await big.load();
  big.add({
    ts: '2026-01-03T00:00:00.000Z', req: 1, method: 'POST', path: '/v1/messages',
    model: 'claude-opus-5', initialAccount: 'seat', account: 'seat', status: 200,
    latencyMs: 1, upstreamAttempts: 1, recoveryPasses: 0, failoverCount: 0,
    retryReasons: ['x'.repeat(4000)], inputTokens: 1, outputTokens: 1,
    cacheReadTokens: 0, cacheCreateTokens: 0,
    inputPreview: ''.repeat(8192), outputPreview: ''.repeat(8192),
  });
  await big.flush();
  const written = (await readFile(bigFile, 'utf8')).trim();
  // Measured off the record that was actually written, not computed from the
  // literals above. The old form was `check(..., 8192 * 6 * 2 > 32_768)` — an
  // inequality over three constants, true at parse time, which cannot fail
  // whatever the store does. It read as evidence that the cap is load-bearing
  // and was evidence of nothing.
  const uncapped = Buffer.byteLength(JSON.stringify({
    ts: '2026-01-03T00:00:00.000Z', req: 1, method: 'POST', path: '/v1/messages',
    model: 'claude-opus-5', initialAccount: 'seat', account: 'seat', status: 200,
    latencyMs: 1, upstreamAttempts: 1, recoveryPasses: 0, failoverCount: 0,
    retryReasons: ['x'.repeat(4000)], inputTokens: 1, outputTokens: 1,
    cacheReadTokens: 0, cacheCreateTokens: 0,
    inputPreview: '\u0001'.repeat(8192), outputPreview: '\u0001'.repeat(8192),
  }));
  check('escaped preview would have overrun the bound', uncapped > 32_768,
    `${uncapped} bytes unescaped-capped`);
  check('written line is capped at MAX_LINE_BYTES', Buffer.byteLength(written) <= 32_768);
  const parsed = JSON.parse(written);
  check('capping drops previews, not diagnostics', parsed.req === 1 && parsed.status === 200);
  check('capping marks the entry truncated', parsed.inputTruncated === true && parsed.outputTruncated === true);
  check('retryReasons strings are bounded', parsed.retryReasons[0].length === 120);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
