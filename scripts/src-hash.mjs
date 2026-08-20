// One hash over everything the build reads, shared by the stamper and the
// suite that checks the stamp. Deliberately one implementation: two of these
// would drift, and a correspondence check that drifts from what it checks is
// worse than not having one, because it reports agreement it did not verify.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Every file under `dir`, relative to it, sorted, with `/` separators. */
function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

/**
 * Hash of `src/` plus `tsconfig.json`. tsconfig is in because it changes the
 * emitted output without changing a single source byte — a target or module
 * change rebuilds everything and nothing under src/ would record it.
 */
export function srcHash(root) {
  const srcDir = join(root, 'src');
  const files = walk(srcDir);
  const h = createHash('sha256');
  for (const rel of files) {
    h.update(rel);
    h.update('\0');
    h.update(readFileSync(join(srcDir, rel)));
    h.update('\0');
  }
  h.update('tsconfig.json\0');
  h.update(readFileSync(join(root, 'tsconfig.json')));
  return { hash: h.digest('hex'), files };
}

export const STAMP_NAME = '.build-stamp.json';
