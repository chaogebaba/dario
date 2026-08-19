#!/usr/bin/env bun
// The debug store must stay bounded when persistence is failing.
//
// Two failure-mode bugs, both reached by the same trigger: a write path that
// keeps throwing. On this machine the way in is a debug log pointed at a
// directory the proxy cannot create — a stale DARIO_DEBUG_LOG_FILE after a
// mount goes away, say.
//
// 1. `pending` was unbounded. mkdir sits before the drain loop, so a failure
//    there leaves the queue untouched and the next request appends to it
//    again. `entries` is a ring and stays flat; `pending` grew forever, on a
//    diagnostics buffer whose entire premise is a bound.
//
// 2. The retry was hot. Every request re-armed the write, and once the file is
//    past the compaction threshold that means a full O(maxEntries)
//    serialization per request: `persistedLines` is only lowered by a
//    SUCCESSFUL rewrite, so a failing one leaves the store above the threshold
//    permanently. The store spent the most CPU exactly when I/O was broken.

import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RequestDebugStore } from '../dist/request-debug.js';

let pass = 0, fail = 0;
function check(name, condition) {
  if (condition) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.error(`  FAIL ${name}`); }
}

const dir = await mkdtemp(join(tmpdir(), 'dario-debug-bounded-'));
const entry = (i) => ({
  ts: new Date(1_700_000_000_000 + i).toISOString(), req: i, method: 'POST', path: '/v1/messages',
  model: 'claude-opus-5', account: 'seat', status: 200, latencyMs: 1,
  upstreamAttempts: 1, recoveryPasses: 0,
  inputTokens: 10, outputTokens: 2, cacheReadTokens: 20, cacheCreateTokens: 3,
  inputChars: 7, outputChars: 8, inputTruncated: false, outputTruncated: false,
});

// A file whose PARENT is a regular file: mkdir(dirname) fails with ENOTDIR on
// every attempt, which is the failure that sits before the drain loop.
const wall = join(dir, 'not-a-dir');
await writeFile(wall, 'x');
const blocked = new RequestDebugStore({ maxEntries: 5, filePath: join(wall, 'sub', 'requests.ndjson') });

const quiet = console.error;
console.error = () => {};
try {
  for (let i = 1; i <= 200; i++) {
    blocked.add(entry(i));
    await blocked.flush();
  }
} finally {
  console.error = quiet;
}

check('the in-memory ring stayed at its bound', blocked.size() === 5);
check(
  `the write queue stayed at its bound (was ${blocked._pendingSizeForTest()})`,
  blocked._pendingSizeForTest() <= 10,
);

// The bound is the file's, not the ring's — surplus beyond the live window is
// what keeps appends O(1), and the queue is allowed to hold that much.
const oldest = blocked.recent().map((e) => e.req).sort((a, b) => a - b)[0];
check('the ring holds the newest entries', oldest === 196);

// 200 requests against a path that can never work must not mean 200 write
// attempts. Backoff starts at 1s and this loop finishes well inside that, so a
// backing-off store records a handful of failures; a hot-retrying one records
// one per request.
check(
  `repeated failure backs off instead of retrying per request (${blocked._persistFailuresForTest()} failures / 200 requests)`,
  blocked._persistFailuresForTest() <= 5,
);
check('but it did actually try', blocked._persistFailuresForTest() >= 1);

// --- a store that recovers keeps working ---
// Same store shape, writable path, driven past the compaction threshold
// (maxEntries * COMPACT_FACTOR = 10 lines) several times over.
const good = new RequestDebugStore({ maxEntries: 5, filePath: join(dir, 'ok', 'requests.ndjson') });
for (let i = 1; i <= 60; i++) good.add(entry(i));
await good.flush();
check('a healthy store still drains its queue', good._pendingSizeForTest() === 0);
check('a healthy store still holds its ring', good.size() === 5);
check('a healthy store records no failures', good._persistFailuresForTest() === 0);
const { readFile } = await import('node:fs/promises');
const lines = (await readFile(join(dir, 'ok', 'requests.ndjson'), 'utf8')).trim().split('\n');
check(`the file stayed within the compaction bound (${lines.length} lines)`, lines.length <= 10);

console.log(`\nrequest-debug-bounded: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
