#!/usr/bin/env bun
// dist/ has to be a build of the src/ sitting next to it.
//
// The suite is split down the middle on which tree it reads. Text assertions
// grep `src/*.ts`; behavioural ones import `dist/*.js`. Nothing checked that
// the two describe the same program, so a source change that was never
// compiled shows green text assertions on the new code and green behavioural
// assertions on the old — the exact state a mutation sweep produced in this
// tree, where the behavioural checks passed against an unmutated dist while
// src was mutated.
//
// It is worse here than the general case. `dist/` on the maintainer's machine
// is a symlink to a build directory shared with other checkouts, so "stale"
// is not only "you forgot to build" — it is also "some other tree built last,
// and every behavioural assertion in this run just tested that tree".
//
// The check is a hash, not an mtime. mtimes pass whenever the other tree
// built more recently, which is precisely the shared-directory case.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { srcHash, STAMP_NAME } from '../scripts/src-hash.mjs';

let pass = 0, fail = 0;
function check(label, condition, detail) {
  if (condition) { console.log(`  ok   ${label}`); pass++; }
  else { console.log(`  ❌ ${label}${detail ? ` (${detail})` : ''}`); fail++; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');
const stampPath = join(distDir, STAMP_NAME);

console.log('\ndist/ corresponds to src/\n');

// A missing dist is the fresh-clone case, and it has to fail loudly rather
// than throw: every other suite in this run imported from it and got whatever
// it found there.
check('dist/ exists', existsSync(distDir), `${distDir} not found — run \`bun run build\``);
check('dist/ carries a build stamp', existsSync(stampPath),
  `${STAMP_NAME} not found — dist/ predates the stamp, or was built by something other than \`bun run build\``);

if (!existsSync(stampPath)) {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
}

const stamp = JSON.parse(readFileSync(stampPath, 'utf-8'));
const { hash, files } = srcHash(root);

check('the stamp records a source hash', typeof stamp.srcHash === 'string' && stamp.srcHash.length === 64,
  JSON.stringify(stamp.srcHash));
check('dist/ was built from this src/', stamp.srcHash === hash,
  stamp.srcHash === hash ? '' : `stamp ${String(stamp.srcHash).slice(0, 12)} vs src ${hash.slice(0, 12)} — run \`bun run build\``);
check('the stamp counts the same source files', stamp.sourceFiles === files.length,
  `stamp ${stamp.sourceFiles} vs ${files.length}`);

// Belt and braces on the part the hash cannot see: a stamp is written by the
// last line of the build, so a `tsc` that emitted nothing but still exited 0
// would stamp an empty dist.
const compiled = files.filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
const missing = compiled
  .map((f) => f.replace(/\.ts$/, '.js'))
  .filter((f) => !existsSync(join(distDir, f)));
check('every compiled source has an emitted counterpart', missing.length === 0,
  missing.slice(0, 5).join(', '));

// The one file the build copies rather than compiles. It is in the hash, so a
// stale copy fails above too — this names it, because "run build" is a less
// useful message than "the template data did not get copied".
check('the template data was copied into dist/',
  existsSync(join(distDir, 'cc-template-data.json')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
