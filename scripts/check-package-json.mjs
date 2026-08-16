#!/usr/bin/env bun
// Fails CI if package.json is invalid JSON or not canonically formatted.
// Guards against the class of bug where a tool writes escaped newlines
// ("\n" as literal backslash-n) instead of real newlines into package.json.

import { readFileSync } from 'node:fs';

const raw = readFileSync('package.json', 'utf-8').replace(/\r\n/g, '\n');

let parsed;
try {
  parsed = JSON.parse(raw);
} catch (e) {
  console.error('package.json is not valid JSON:', e.message);
  console.error('First 200 chars:', JSON.stringify(raw.slice(0, 200)));
  process.exit(1);
}

const canonical = JSON.stringify(parsed, null, 2) + '\n';
if (raw !== canonical) {
  console.error('package.json is not canonically formatted.');
  console.error('Expected: 2-space indent, trailing newline, real newlines (not escaped \\n).');
  console.error('To fix, run: bun run fix:pkg');
  process.exit(1);
}

console.log('package.json OK');
