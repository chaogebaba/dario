// The runner scores a suite on its exit code. That was not enough: startProxy
// exited 0 when its port was already held by a healthy dario, so a suite could
// bind nothing, assert nothing, and be counted as passed. proxy.ts no longer
// exits on a caller's behalf, and the runner now also requires a suite to say
// how many assertions it made. This covers the second half — every tally
// spelling in the tree must be readable, or a real suite starts scoring as a
// failure for the wrong reason.

import { readTally } from './lib/read-tally.mjs';

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);

header('every spelling in the tree is readable');
const shapes = [
  ['bare pass/fail',        '\n7 pass, 0 fail\n',                  { pass: 7, fail: 0 }],
  ['passed/failed',         '\n35 passed, 2 failed\n',             { pass: 35, fail: 2 }],
  ['Results: prefix',       '  Results: 12 passed, 0 failed\n',    { pass: 12, fail: 0 }],
  ['uppercase RESULTS',     '  RESULTS: 4 passed, 1 failed\n',     { pass: 4, fail: 1 }],
  ['two-line TAP-ish',      '\n# pass 34\n# fail 0\n',             { pass: 34, fail: 0 }],
  ['ratio of checks',       '  9/11 checks passed\n',              { pass: 9, fail: 2 }],
  ['assertions passed',     '✅ model-catalog: 88 assertions passed\n', { pass: 88, fail: 0 }],
  ['bare PASS lines',       'PASS a\nPASS b\nFAIL c\n',            { pass: 2, fail: 1 }],
];
for (const [name, text, want] of shapes) {
  const got = readTally(text);
  check(name, got && got.pass === want.pass && got.fail === want.fail, JSON.stringify(got));
}

header('the cases that must NOT read as a tally');
check('empty output', readTally('') === null);
check('a startProxy "already running" banner alone', readTally(
  '\n  dario — already running on http://localhost:38781\n\n  OAuth: healthy  |  requests served: 7\n\n'
) === null, JSON.stringify(readTally('  dario — already running on http://localhost:38781\n  OAuth: healthy  |  requests served: 7')));

header('the last tally wins');
check('a suite printing sections then a total',
  readTally('3 pass, 0 fail\n5 pass, 1 fail\n')?.pass === 5);

header('a zero-assertion tally is representable, so the runner can reject it');
check('0 pass, 0 fail parses rather than returning null',
  JSON.stringify(readTally('0 pass, 0 fail')) === JSON.stringify({ pass: 0, fail: 0 }));

// Deliberately NOT asserted here: "every suite in the tree emits a readable
// tally." Checking that means scanning suite *source* for summary spellings,
// which is the same thing the audit called out — an assertion that constrains
// how a line is written rather than what the code does, and it goes red for a
// file whose summary is a string literal rather than a template. The runner
// enforces the real invariant at the only moment it can be observed: a suite
// that exits 0 without a readable tally is failed on the spot.

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
