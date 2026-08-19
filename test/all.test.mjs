#!/usr/bin/env bun
// Top-level parallel test runner — dario#79 (Claude review push-back).
//
// Previous shape: `npm test` was a single `node test/a.mjs && node test/b.mjs
// && …` chain of 34 serial invocations. Problems:
//   1. No parallelism — total time = sum of all files; most are independent.
//   2. First-failure exits — if file #1 fails, files #2-34 never run, so you
//      can't see whether a second unrelated failure also exists without first
//      fixing the first one.
//   3. No unified reporter — each file prints its own ad-hoc "N pass, M fail"
//      tally; CI log has 34 separate summary lines to scan.
//
// This driver wraps every existing `*.mjs` in `test/` (except opt-out E2E /
// compat files that expect live proxy state), spawning each as a subprocess
// with a bounded worker pool. The existing files stay untouched — their own
// `check(name, cond)` assertion style and `process.exit(fail === 0 ? 0 : 1)`
// semantics work as-is.
//
// Run: `bun test/all.test.mjs`
//
// Deliberately does NOT use `node:test`: Bun rejects it outside `bun test`
// ("Cannot use test outside of the test runner"), and `bun test` will not
// discover `*.mjs` files — it only matches `.test.`/`_test_`/`.spec.` names.
// Renaming 130+ suites to satisfy a discovery pattern would be a large
// diff for no behavioural gain, so the driver owns its own scheduling and
// reporting and stays runtime-agnostic.
//
// Zero runtime dependencies. Stays true to the package's dep-hygiene invariant.

import { spawn } from 'node:child_process';
import { readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { readTally } from './lib/read-tally.mjs';
import { jsSuites, shellSuites } from './lib/suites.mjs';
import { writeHeadlessLiveCache } from './lib/headless-live-cache.mjs';
import { cpus } from 'node:os';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const files = jsSuites(__dirname);
const shellFiles = shellSuites(__dirname);

// Every child gets the live-template cache pointed at a path the driver owns,
// holding a cache in the shape a real headless capture writes. Two things at
// once: the suite stays independent of local machine state, AND it runs in the
// configuration dario actually runs in.
//
// It used to point at a path that did not exist, so loadTemplate always fell
// back to the BUNDLED snapshot. That covered the first half and abandoned the
// second, and the abandoned half is where the bugs were: a live cache holding
// a fraction of the bundle's tools is the production configuration on every
// machine with CC installed, and it is exactly the configuration the tool-union
// regression survived in. A suite that only ever sees the bundle cannot test
// how live and bundle combine, because it never combines them.
//
// The old comment recorded three suites — tool-advertise-respects-client,
// template-interactive-tools and issue-29-tool-translation — as failing when a
// real live cache was present, and treated that as a reason to hide the cache.
// It was a reason to fix them. They pass against this fixture: the read-time
// union (withBundledFallbacks) restores the interactive tools those suites
// assert on, which is the behaviour they should have been pinning all along.
//
// dario#867 closed the write half of the isolation — the tests no longer
// POISON the operator's cache. This is the read half: they must not depend on
// whether you happened to start the proxy an hour ago either. A fixture the
// driver writes is deterministic in a way both "no cache" and "whatever is in
// ~/.dario" are not.
//
// Files that genuinely exercise the live-cache path (test/live-fingerprint.mjs)
// assign their own override in-process, which wins over this inherited value.
const suiteTemplateDir = mkdtempSync(join(tmpdir(), 'dario-suite-template-'));
const suiteTemplateCache = join(suiteTemplateDir, 'cc-template.live.json');
writeHeadlessLiveCache(suiteTemplateCache, join(__dirname, '..', 'dist', 'cc-template-data.json'));
// The dir has to outlive every child, and the driver exits from four places
// (bad TEST_CONCURRENCY, SIGINT, dropped-job bug, normal finish). An exit hook
// is the one placement that covers all of them.
process.on('exit', () => rmSync(suiteTemplateDir, { recursive: true, force: true }));
const childEnv = { ...process.env, DARIO_LIVE_TEMPLATE_CACHE: suiteTemplateCache };

// ── Runner ───────────────────────────────────────────────────────────
// Concurrency defaults to half the cores, capped at 8. Each child is a
// full runtime with its own heap, so this is memory-bound rather than
// CPU-bound — oversubscribing trades a little wall-clock for a real risk
// of the OOM killer taking out the run. Override with TEST_CONCURRENCY.
// A bad value must not quietly shrink the run. `Number('abc')` is NaN,
// `Math.max(1, NaN)` is NaN, and `Array.from({length: NaN})` is empty — so
// TEST_CONCURRENCY=abc used to spawn zero workers, run zero suites, and
// exit 0. A typo'd env var reporting a green suite is the worst outcome
// available here, so reject rather than fall back to a default.
function intEnv(name, dflt, min) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
    console.error(`${name}=${JSON.stringify(raw)} is not an integer >= ${min}.`);
    process.exit(2);
  }
  return n;
}

const CONCURRENCY = intEnv('TEST_CONCURRENCY', Math.min(8, Math.ceil(cpus().length / 2)), 1);

// Per-suite output cap. Suites are chatty (some print thousands of
// assertion lines); retaining all of it for 130+ files at once is what
// pushed the old runner into swap. Keep a bounded tail — the failing
// assertions and the summary are always at the end — and drop it
// entirely the moment a suite passes.
const MAX_CAPTURE = 64 * 1024;

/**
 * Bounded tail buffer. Appends are O(chunk); memory stays under
 * ~MAX_CAPTURE regardless of how much the child prints.
 */
function tailBuffer(limit) {
  let chunks = [];
  let size = 0;
  return {
    push(d) {
      const s = typeof d === 'string' ? d : d.toString();
      chunks.push(s);
      size += s.length;
      // Amortised trim: only compact once we're well over the cap.
      if (size > limit * 2) {
        const joined = chunks.join('').slice(-limit);
        chunks = [joined];
        size = joined.length;
      }
    },
    value() {
      const joined = chunks.join('');
      return joined.length > limit
        ? `…(truncated ${joined.length - limit} bytes)…\n${joined.slice(-limit)}`
        : joined;
    },
  };
}

// Per-suite wall-clock cap. Without one, a single suite that wedges (a
// socket that never closes, an unref'd guard timer that can never fire)
// hangs the whole run — and CI — indefinitely, with no output to say
// which file did it. 120s is ~20x the slowest honest suite. Override
// with TEST_TIMEOUT_MS.
const TIMEOUT_MS = intEnv('TEST_TIMEOUT_MS', 120_000, 1000);

// Children outlive the driver if it dies mid-run (Ctrl-C, OOM kill),
// which is how the machine ended up with a pile of orphaned test
// processes. Track them and take them down on the way out.
//
// `detached: true` puts each suite in its own process group so a kill
// reaches its descendants too. Several suites fan out (the installer
// suite runs bash and spawns ~11 processes; hermes-compat, effort-flag,
// version-advances and health-verdict all spawn grandchildren), and
// signalling only the direct child leaves those running.
const live = new Set();
function killTree(proc, signal = 'SIGKILL') {
  try { process.kill(-proc.pid, signal); }
  catch { try { proc.kill(signal); } catch { /* already gone */ } }
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const p of live) killTree(p);
    process.exit(130);
  });
}


/** Run one suite file to completion. Resolves with its outcome. */
function runSuite(file, argv) {
  const started = Date.now();
  return new Promise((resolve) => {
    const proc = spawn(argv[0], argv.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Inherited env plus the pinned template cache (see above).
      env: childEnv,
      detached: true,
    });
    live.add(proc);
    const buf = tailBuffer(MAX_CAPTURE);
    proc.stdout.on('data', d => buf.push(d));
    proc.stderr.on('data', d => buf.push(d));

    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(proc);
    }, TIMEOUT_MS);

    const finish = (code, extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      live.delete(proc);
      const failed = timedOut || code !== 0;
      // Read the tally before the output is dropped. A passing suite still
      // keeps no text, so peak memory is unchanged.
      const text = buf.value();
      resolve({
        file,
        // A SIGKILLed child reports code null; that must not read as pass.
        code: timedOut ? 'timeout' : (code ?? 'signal'),
        out: failed ? `${extra ?? ''}${text}` : '',
        tally: readTally(text),
        ms: Date.now() - started,
      });
    };

    // 'close' is the one that guarantees the output tail is complete, so
    // it stays the normal path. It is NOT sufficient on its own: it fires
    // only once every stdio pipe reaches EOF, and a grandchild that
    // inherited the pipe holds it open after the child itself is gone —
    // including after a timeout SIGKILL, which never reached the
    // grandchild before `detached`. That combination leaked a pool slot
    // permanently and hung the driver with a green transcript. 'exit'
    // fires on process death regardless of pipes; give the pipes a brief
    // grace to flush, then report anyway.
    let drainTimer = null;
    proc.on('close', code => finish(code, timedOut ? `TIMED OUT after ${TIMEOUT_MS}ms — killed.\n` : ''));
    proc.on('exit', code => {
      if (settled) return;
      drainTimer = setTimeout(() => {
        killTree(proc);
        finish(code, `${timedOut ? `TIMED OUT after ${TIMEOUT_MS}ms — killed.\n` : ''}`
          + 'NOTE: a descendant process outlived this suite and kept its output pipe open.\n');
      }, 500);
      if (typeof drainTimer.unref === 'function') drainTimer.unref();
    });
    proc.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      live.delete(proc);
      resolve({ file, code: 1, out: String(err?.stack || err), ms: Date.now() - started });
    });
  });
}

const jobs = [
  ...files.map(f => ({ file: f, argv: [process.execPath, join(__dirname, f)] })),
  // Shell-level suites (packaging/installer) run through bash but are
  // reported alongside the rest, so a broken installer fails the suite
  // like any other regression.
  ...shellFiles.map(f => ({ file: f, argv: ['bash', join(__dirname, f)] })),
];

const results = [];
let cursor = 0;
let passed = 0;

async function worker() {
  while (cursor < jobs.length) {
    const job = jobs[cursor++];
    const r = await runSuite(job.file, job.argv);
    // Exit 0 with a tally of zero assertions is a suite that did not run.
    // It is scored as a failure, not silently as a pass.
    if (r.code === 0 && r.tally && r.tally.pass === 0 && r.tally.fail === 0) {
      r.code = 'no-assertions';
      r.out = `suite exited 0 but reported 0 assertions\n${r.out}`;
    }
    if (r.code === 0 && r.tally === null) {
      r.code = 'no-tally';
      r.out = `suite exited 0 but printed no assertion tally this runner can read.\nAdd a summary line — "N pass, M fail" is the majority spelling — so a suite\nthat exits without running cannot be scored as a pass.\n${r.out}`;
    }
    if (r.code === 0) passed++;
    // Retain full records only for failures; a passing suite keeps just
    // its timing, so peak memory doesn't scale with suite count.
    results.push(r.code === 0 ? { file: r.file, code: 0, ms: r.ms } : r);
    process.stdout.write(
      `  ${r.code === 0 ? 'ok  ' : 'FAIL'} ${r.file} (${r.ms}ms)\n`,
    );
  }
}

console.log(`Running ${jobs.length} suites, concurrency ${CONCURRENCY}\n`);
const wallStart = Date.now();
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
const wallMs = Date.now() - wallStart;

const failed = results.filter(r => r.code !== 0).sort((a, b) => a.file.localeCompare(b.file));

// A driver that drops jobs must not report success. Nothing else checks
// this: `passed`, `failed` and the summary are all derived from what the
// pool actually ran, so any path that skips work looks identical to a
// clean run.
if (results.length !== jobs.length) {
  console.error(`\nDRIVER BUG: ${jobs.length} suites queued but ${results.length} ran.`);
  process.exit(2);
}

// Failure output comes last, so it's what you see without scrolling.
for (const r of failed) {
  console.log(`\n${'─'.repeat(70)}\n--- ${r.file} exited with code ${r.code} ---\n${r.out}`);
}

console.log(
  `\n${'='.repeat(70)}\n` +
  `  ${passed}/${results.length} suites passed` +
  `${failed.length ? ` — ${failed.length} failed: ${failed.map(f => f.file).join(', ')}` : ''}\n` +
  `  ${(wallMs / 1000).toFixed(1)}s wall\n` +
  `${'='.repeat(70)}`,
);

process.exit(failed.length === 0 ? 0 : 1);
