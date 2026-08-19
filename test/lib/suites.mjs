// Which files the runner actually runs. Shared so that anything asserting
// about "every suite" agrees with the driver instead of re-deriving the list
// and disagreeing at the edges.
//
// Files the driver skips:
//   - all.test.mjs — self-reference would recurse
//   - e2e.mjs, compat.mjs, stealth-test.mjs — live-integration tests that
//     expect a running proxy / real Anthropic key / real subscription; they
//     have their own `npm run e2e`, `npm run compat` entry points and are
//     intentionally excluded from the default test script
import { readdirSync } from 'node:fs';

export const EXCLUDED = new Set([
  'all.test.mjs',
  'e2e.mjs',
  'stress.mjs',
  'infra-probe.mjs',
  'compat.mjs',
  'stealth-test.mjs',
  // Live in-process e2e — patches global fetch and starts a real proxy.
  // Run manually with: node test/overage-guard-e2e-live.mjs (dario#288).
  'overage-guard-e2e-live.mjs',
]);

/** JS suites the runner executes, sorted. */
export function jsSuites(dir) {
  return readdirSync(dir).filter(f => f.endsWith('.mjs') && !EXCLUDED.has(f)).sort();
}

/** Shell suites the runner executes, sorted. */
export function shellSuites(dir) {
  return readdirSync(dir).filter(f => f.endsWith('.test.sh') && !EXCLUDED.has(f)).sort();
}
