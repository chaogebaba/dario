import { basename, join } from 'node:path';

import { homeDir } from './home-dir.js';

const ACCOUNTS_DIR = join(homeDir(), '.dario', 'accounts');

/** Return whether an alias is a portable, filesystem-safe account filename. */
export function isValidAccountAlias(alias: unknown): alias is string {
  if (typeof alias !== 'string' || alias.length === 0) return false;
  const leaf = basename(alias);
  const windowsStem = leaf.split('.')[0]!.toUpperCase();
  const windowsReserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(windowsStem);
  return leaf === alias
    && leaf !== '.'
    && leaf !== '..'
    && !leaf.endsWith('.')
    && !windowsReserved
    && /^[A-Za-z0-9][A-Za-z0-9_\-.]{0,63}$/.test(leaf);
}

/** Resolve a validated alias to its credential file, or null when invalid. */
export function accountFilePath(alias: string): string | null {
  return isValidAccountAlias(alias) ? join(ACCOUNTS_DIR, `${alias}.json`) : null;
}

export function getAccountsDir(): string {
  return ACCOUNTS_DIR;
}
