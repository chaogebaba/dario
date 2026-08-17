import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { getAccountsDir } from './account-alias.js';

const accountOperationTails = new Map<string, Promise<void>>();
const LOCK_RETRY_MS = 25;
const LOCK_WAIT_TIMEOUT_MS = 30_000;
const STALE_LOCK_MS = 60_000;

interface FileLock {
  path: string;
  token: string;
}

/**
 * Serialize operations touching any of the supplied account aliases.
 *
 * Keys are case-folded because aliases map to filenames and must behave the
 * same on case-sensitive and case-insensitive filesystems. Multi-alias
 * operations publish one shared tail, which avoids lock-order deadlocks.
 */
export async function withAccountLocks<T>(
  aliases: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const unique = [...new Set(aliases.map((alias) => alias.toLowerCase()))].sort();
  const previous = unique.map((alias) => accountOperationTails.get(alias) ?? Promise.resolve());
  let release!: () => void;
  const tail = new Promise<void>((resolve) => { release = resolve; });
  for (const alias of unique) accountOperationTails.set(alias, tail);
  await Promise.all(previous.map((pending) => pending.catch(() => {})));
  const fileLocks: FileLock[] = [];
  try {
    for (const alias of unique) fileLocks.push(await acquireFileLock(alias));
    return await operation();
  } finally {
    for (const lock of fileLocks.reverse()) await releaseFileLock(lock);
    release();
    for (const alias of unique) {
      if (accountOperationTails.get(alias) === tail) accountOperationTails.delete(alias);
    }
  }
}

async function acquireFileLock(alias: string): Promise<FileLock> {
  const lockDir = join(getAccountsDir(), '.locks');
  await mkdir(lockDir, { recursive: true, mode: 0o700 });
  const path = join(lockDir, `${alias}.lock`);
  const token = randomUUID();
  const startedAt = Date.now();

  for (;;) {
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), token }));
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { path, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await removeStaleLock(path)) continue;
      if (Date.now() - startedAt >= LOCK_WAIT_TIMEOUT_MS) {
        throw new Error(`timed out waiting for account lock: ${alias}`);
      }
      await delay(LOCK_RETRY_MS);
    }
  }
}

async function removeStaleLock(path: string): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf-8')) as {
      pid?: unknown;
      acquiredAt?: unknown;
    };
    const acquiredAt = typeof raw.acquiredAt === 'number' ? raw.acquiredAt : 0;
    const pid = typeof raw.pid === 'number' ? raw.pid : 0;
    const ownerAlive = pid > 0 && isProcessAlive(pid);
    if (ownerAlive && Date.now() - acquiredAt < STALE_LOCK_MS) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    // A contender can observe the file between the owner's atomic create and
    // metadata write. Preserve recent malformed/unreadable files; only reap
    // one after the same stale threshold used for a dead owner.
    try {
      const info = await stat(path);
      if (Date.now() - info.mtimeMs < STALE_LOCK_MS) return false;
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code === 'ENOENT') return true;
      return false;
    }
  }

  try {
    await unlink(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

async function releaseFileLock(lock: FileLock): Promise<void> {
  try {
    const raw = JSON.parse(await readFile(lock.path, 'utf-8')) as { token?: unknown };
    if (raw.token === lock.token) await unlink(lock.path);
  } catch {
    // Best effort on shutdown/error paths. Stale-owner recovery handles a
    // lock left behind by an interrupted process.
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
