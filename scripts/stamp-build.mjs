#!/usr/bin/env bun
// Record what src/ looked like when dist/ was produced. Runs as the last step
// of `bun run build`; test/dist-matches-src.mjs reads it back.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { srcHash, STAMP_NAME } from './src-hash.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { hash, files } = srcHash(root);
writeFileSync(
  join(root, 'dist', STAMP_NAME),
  `${JSON.stringify({ srcHash: hash, sourceFiles: files.length }, null, 2)}\n`,
);
console.log(`build stamp: ${hash.slice(0, 12)} over ${files.length} source files`);
