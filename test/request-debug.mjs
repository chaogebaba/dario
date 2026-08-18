import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
const file = join(dir, 'requests.ndjson');
const store = new RequestDebugStore({ maxEntries: 3, filePath: file });
await store.load();
for (let i = 1; i <= 4; i++) {
  store.add({
    ts: `2026-01-01T00:00:0${i}.000Z`, req: i, method: 'POST', path: '/v1/messages',
    model: 'claude-opus-5', account: 'seat', status: 200, latencyMs: i,
    upstreamAttempts: i === 3 ? 2 : 1, recoveryPasses: i === 3 ? 1 : 0,
    inputTokens: 10, outputTokens: 2, cacheReadTokens: 20, cacheCreateTokens: 3,
  });
}
await store.flush();
check('FIFO evicts oldest in memory', store.recent().map((e) => e.req).join(',') === '4,3,2');
check('capacity is reported', store.size() === 3 && store.maxEntries === 3);
const lines = (await readFile(file, 'utf8')).trim().split('\n');
check('FIFO evicts oldest on disk', lines.length === 3 && JSON.parse(lines[0]).req === 2);

const restored = new RequestDebugStore({ maxEntries: 3, filePath: file });
await restored.load();
check('recent entries survive restart', restored.recent().map((e) => e.req).join(',') === '4,3,2');
check('attempt diagnostics survive restart', restored.recent().find((e) => e.req === 3)?.upstreamAttempts === 2);

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

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
