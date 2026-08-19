import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';

import { accountFilePath, getAccountsDir, isValidAccountAlias } from './account-alias.js';
import { withAccountLocks } from './account-operation-lock.js';
import { durableCreateFile, durableWriteFile } from './durable-write.js';

export interface AccountCredentials {
  alias: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  deviceId: string;
  accountUuid: string;
  enabled?: boolean;
}

export type RenameAccountResult = 'renamed' | 'not-found' | 'conflict' | 'invalid' | 'internal';

export class AccountStoreError extends Error {
  constructor(
    message: string,
    public readonly kind: Exclude<RenameAccountResult, 'renamed'>,
    public readonly code?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AccountStoreError';
  }
}

/** Runtime guard for credentials crossing the JSON storage boundary. */
export function isAccountCredentials(
  value: unknown,
  expectedAlias?: string,
): value is AccountCredentials {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return isValidAccountAlias(candidate.alias)
    && (expectedAlias === undefined || candidate.alias === expectedAlias)
    && typeof candidate.accessToken === 'string'
    && candidate.accessToken.length > 0
    && typeof candidate.refreshToken === 'string'
    && candidate.refreshToken.length > 0
    && typeof candidate.expiresAt === 'number'
    && Number.isFinite(candidate.expiresAt)
    && Array.isArray(candidate.scopes)
    && candidate.scopes.every((scope) => typeof scope === 'string')
    && typeof candidate.deviceId === 'string'
    && typeof candidate.accountUuid === 'string';
}

async function ensureAccountsDir(): Promise<void> {
  await mkdir(getAccountsDir(), { recursive: true, mode: 0o700 });
}

export async function listAccountAliases(): Promise<string[]> {
  try {
    await ensureAccountsDir();
    const entries = await readdir(getAccountsDir());
    return entries
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.slice(0, -'.json'.length))
      .filter(isValidAccountAlias);
  } catch {
    return [];
  }
}

export async function loadAccount(alias: string): Promise<AccountCredentials | null> {
  const path = accountFilePath(alias);
  if (!path) return null;
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf-8'));
    if (!isAccountCredentials(parsed, alias)) return null;
    return { ...parsed, enabled: parsed.enabled !== false };
  } catch {
    return null;
  }
}

export async function toggleAccountEnabled(alias: string): Promise<AccountCredentials | null> {
  const path = accountFilePath(alias);
  if (!path) return null;
  return withAccountLocks([alias], async () => {
    const current = await loadAccount(alias);
    if (!current) return null;
    const updated = { ...current, enabled: current.enabled === false };
    await saveAccountWhileLocked(updated, path);
    return updated;
  });
}

export async function loadAllAccounts(): Promise<AccountCredentials[]> {
  const aliases = await listAccountAliases();
  const loaded = await Promise.all(aliases.map((alias) => loadAccount(alias)));
  return loaded.filter((account): account is AccountCredentials => account !== null);
}

/** Public overwrite API. Every save participates in per-alias serialization. */
export async function saveAccount(creds: AccountCredentials): Promise<void> {
  const path = accountFilePath(creds.alias);
  if (!path) throw storeError('invalid', `invalid account alias: ${creds.alias}`);
  await withAccountLocks([creds.alias], () => saveAccountWhileLocked(creds, path));
}

/** Persist while the caller already owns the alias lock. */
export async function saveAccountWhileLocked(
  creds: AccountCredentials,
  path = accountFilePath(creds.alias),
): Promise<void> {
  const alias = creds.alias;
  if (!path) throw storeError('invalid', `invalid account alias: ${alias}`);
  if (!isAccountCredentials(creds)) {
    throw storeError('invalid', `invalid credentials for account: ${alias}`);
  }
  await ensureAccountsDir();
  await durableWriteFile(path, JSON.stringify(creds, null, 2), 0o600);
}

export async function assertAccountAliasAvailable(alias: string): Promise<void> {
  if (!isValidAccountAlias(alias)) throw storeError('invalid', `invalid account alias: ${alias}`);
  const folded = alias.toLowerCase();
  if ((await listAccountAliases()).some((existing) => existing.toLowerCase() === folded)) {
    throw storeError('conflict', `account alias already exists: ${alias}`, 'EEXIST');
  }
}

export async function createAccount(creds: AccountCredentials, signal?: AbortSignal): Promise<void> {
  const alias = creds.alias;
  const path = accountFilePath(alias);
  if (!path) throw storeError('invalid', `invalid account alias: ${alias}`);
  if (!isAccountCredentials(creds)) {
    throw storeError('invalid', `invalid credentials for account: ${alias}`);
  }
  await withAccountLocks([creds.alias], async () => {
    await assertAccountAliasAvailable(creds.alias);
    throwIfAborted(signal);
    await ensureAccountsDir();
    await durableCreateFile(path, JSON.stringify(creds, null, 2), 0o600);
    if (signal?.aborted) {
      await unlink(path).catch(() => {});
      throw signal.reason ?? new Error('account creation cancelled');
    }
  });
}

export async function replaceAccount(creds: AccountCredentials): Promise<void> {
  const alias = creds.alias;
  const path = accountFilePath(alias);
  if (!path) throw storeError('invalid', `invalid account alias: ${alias}`);
  if (!isAccountCredentials(creds)) {
    throw storeError('invalid', `invalid credentials for account: ${alias}`);
  }
  await withAccountLocks([creds.alias], async () => {
    if (!(await loadAccount(creds.alias))) {
      throw storeError('not-found', `account not found: ${creds.alias}`, 'ENOENT');
    }
    await saveAccountWhileLocked(creds, path);
  });
}

export async function removeAccount(alias: string): Promise<boolean> {
  const path = accountFilePath(alias);
  if (!path) return false;
  return withAccountLocks([alias], async () => {
    try {
      await unlink(path);
      return true;
    } catch {
      return false;
    }
  });
}

export async function renameAccount(oldAlias: string, newAlias: string): Promise<boolean> {
  return (await renameAccountWithResult(oldAlias, newAlias)) === 'renamed';
}

export async function renameAccountWithResult(
  oldAlias: string,
  newAlias: string,
): Promise<RenameAccountResult> {
  const oldPath = accountFilePath(oldAlias);
  const newPath = accountFilePath(newAlias);
  if (!oldPath || !newPath) return 'invalid';

  return withAccountLocks([oldAlias, newAlias], async () => {
    if (oldPath === newPath) return (await loadAccount(oldAlias)) ? 'renamed' : 'not-found';
    try {
      const foldedNew = newAlias.toLowerCase();
      if ((await listAccountAliases()).some((alias) => alias.toLowerCase() === foldedNew)) {
        return 'conflict';
      }
      const parsed: unknown = JSON.parse(await readFile(oldPath, 'utf-8'));
      if (!isAccountCredentials(parsed, oldAlias)) return 'internal';
      const creds = parsed;
      creds.alias = newAlias;
      await ensureAccountsDir();
      await durableCreateFile(newPath, JSON.stringify(creds, null, 2), 0o600);
      await unlink(oldPath);
      return 'renamed';
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return 'conflict';
      if (code === 'ENOENT') return 'not-found';
      return 'internal';
    }
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error('account creation cancelled');
}

function storeError(
  kind: Exclude<RenameAccountResult, 'renamed'>,
  message: string,
  code?: string,
  cause?: unknown,
): AccountStoreError {
  return new AccountStoreError(message, kind, code, cause === undefined ? undefined : { cause });
}

export { getAccountsDir, isValidAccountAlias } from './account-alias.js';
