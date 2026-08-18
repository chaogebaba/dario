import { appendFile, chmod, mkdir, open, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

/** Redacted, bounded request facts intended for automated diagnosis. */
export interface RequestDebugEntry {
  ts: string;
  req: number;
  method: string;
  path: string;
  model: string;
  initialAccount: string;
  account: string;
  status: number;
  latencyMs: number;
  upstreamAttempts: number;
  recoveryPasses: number;
  failoverCount: number;
  retryReasons: string[];
  outcome?: 'complete' | 'stream-error' | 'timeout' | 'network-error' | 'client-closed';
  error?: string;
  selectionReason?: string;
  affinitySource?: string | null;
  affinityFingerprint?: string | null;
  affinitySignals?: Array<{ source: string; fingerprint: string; bindingEligible: boolean; selected: boolean }>;
  affinityResult?: 'hit' | 'new' | 'rebind' | 'none' | 'disabled';
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  bodyBytes?: number;
  bodyFingerprint?: string;
  client?: string;
  semanticFingerprint?: string;
  inputPreview?: string;
  outputPreview?: string;
  inputChars?: number;
  outputChars?: number;
  inputTruncated?: boolean;
  outputTruncated?: boolean;
}

export interface RequestDebugStoreOptions {
  maxEntries?: number;
  filePath?: string | null;
}

const DEFAULT_MAX_ENTRIES = 512;
// Preview-bearing entries are intentionally bounded in both count and worst
// case file size (about 64 MiB at the largest permitted configuration).
const MAX_ENTRIES_CAP = 2_048;
const MAX_MODEL_LENGTH = 128;
const MAX_ERROR_LENGTH = 256;
const MAX_PREVIEW_LENGTH = 8_192;
const MAX_LINE_BYTES = 32_768;
const AFFINITY_RESULTS = new Set(['hit', 'new', 'rebind', 'none', 'disabled']);
const OUTCOMES = new Set(['complete', 'stream-error', 'timeout', 'network-error', 'client-closed']);

function boundedLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_ENTRIES;
  return Math.max(1, Math.min(MAX_ENTRIES_CAP, Math.floor(value!)));
}

function validString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function normalizeEntry(value: unknown): RequestDebugEntry | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.ts !== 'string' || typeof raw.req !== 'number') return null;
  const reasons = Array.isArray(raw.retryReasons)
    ? raw.retryReasons.filter((r): r is string => typeof r === 'string').slice(0, 16)
    : [];
  const signals = Array.isArray(raw.affinitySignals)
    ? raw.affinitySignals.flatMap((s) => {
      if (!s || typeof s !== 'object') return [];
      const v = s as Record<string, unknown>;
      return typeof v.source === 'string' && typeof v.fingerprint === 'string' && typeof v.bindingEligible === 'boolean' && typeof v.selected === 'boolean'
        ? [{ source: v.source.slice(0, 80), fingerprint: v.fingerprint.slice(0, 32), bindingEligible: v.bindingEligible, selected: v.selected }]
        : [];
    }).slice(0, 16)
    : undefined;
  return {
    ts: raw.ts.slice(0, 40), req: Math.max(0, Math.floor(raw.req)), method: validString(raw.method, 16),
    path: validString(raw.path, 128), model: validString(raw.model, MAX_MODEL_LENGTH),
    initialAccount: validString(raw.initialAccount, MAX_MODEL_LENGTH), account: validString(raw.account, MAX_MODEL_LENGTH),
    status: typeof raw.status === 'number' ? Math.floor(raw.status) : 0,
    latencyMs: typeof raw.latencyMs === 'number' ? Math.max(0, Math.floor(raw.latencyMs)) : 0,
    upstreamAttempts: typeof raw.upstreamAttempts === 'number' ? Math.max(1, Math.floor(raw.upstreamAttempts)) : 1,
    recoveryPasses: typeof raw.recoveryPasses === 'number' ? Math.max(0, Math.floor(raw.recoveryPasses)) : 0,
    failoverCount: typeof raw.failoverCount === 'number' ? Math.max(0, Math.floor(raw.failoverCount)) : 0,
    retryReasons: reasons,
    ...(typeof raw.outcome === 'string' && OUTCOMES.has(raw.outcome) ? { outcome: raw.outcome as RequestDebugEntry['outcome'] } : {}),
    ...(typeof raw.error === 'string' ? { error: raw.error.slice(0, MAX_ERROR_LENGTH) } : {}),
    ...(typeof raw.selectionReason === 'string' ? { selectionReason: raw.selectionReason.slice(0, 40) } : {}),
    ...(typeof raw.affinitySource === 'string' || raw.affinitySource === null ? { affinitySource: raw.affinitySource as string | null } : {}),
    ...(typeof raw.affinityFingerprint === 'string' || raw.affinityFingerprint === null ? { affinityFingerprint: raw.affinityFingerprint as string | null } : {}),
    ...(signals ? { affinitySignals: signals } : {}),
    ...(typeof raw.affinityResult === 'string' && AFFINITY_RESULTS.has(raw.affinityResult) ? { affinityResult: raw.affinityResult as RequestDebugEntry['affinityResult'] } : {}),
    inputTokens: typeof raw.inputTokens === 'number' ? Math.max(0, Math.floor(raw.inputTokens)) : 0,
    outputTokens: typeof raw.outputTokens === 'number' ? Math.max(0, Math.floor(raw.outputTokens)) : 0,
    cacheReadTokens: typeof raw.cacheReadTokens === 'number' ? Math.max(0, Math.floor(raw.cacheReadTokens)) : 0,
    cacheCreateTokens: typeof raw.cacheCreateTokens === 'number' ? Math.max(0, Math.floor(raw.cacheCreateTokens)) : 0,
    ...(typeof raw.bodyBytes === 'number' ? { bodyBytes: Math.max(0, Math.floor(raw.bodyBytes)) } : {}),
    ...(typeof raw.bodyFingerprint === 'string' ? { bodyFingerprint: raw.bodyFingerprint.slice(0, 32) } : {}),
    ...(typeof raw.client === 'string' ? { client: raw.client.slice(0, 80) } : {}),
    ...(typeof raw.semanticFingerprint === 'string' ? { semanticFingerprint: raw.semanticFingerprint.slice(0, 32) } : {}),
    ...(typeof raw.inputPreview === 'string' ? { inputPreview: raw.inputPreview.slice(0, MAX_PREVIEW_LENGTH) } : {}),
    ...(typeof raw.outputPreview === 'string' ? { outputPreview: raw.outputPreview.slice(0, MAX_PREVIEW_LENGTH) } : {}),
    ...(typeof raw.inputChars === 'number' ? { inputChars: Math.max(0, Math.floor(raw.inputChars)) } : {}),
    ...(typeof raw.outputChars === 'number' ? { outputChars: Math.max(0, Math.floor(raw.outputChars)) } : {}),
    ...(typeof raw.inputTruncated === 'boolean' ? { inputTruncated: raw.inputTruncated } : {}),
    ...(typeof raw.outputTruncated === 'boolean' ? { outputTruncated: raw.outputTruncated } : {}),
  };
}

/**
 * A small FIFO ring with optional JSON-ND persistence. The file is metadata
 * plus bounded semantic previews. Files are mode 0600 and writes are
 * serialized so concurrent requests cannot reorder or truncate the window.
 */
export class RequestDebugStore {
  readonly maxEntries: number;
  readonly filePath: string | null;
  private entries: RequestDebugEntry[] = [];
  private persistedLines = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private persistScheduled = false;
  private persistNeeded = false;
  private readonly salt = randomBytes(16);

  constructor(options: RequestDebugStoreOptions = {}) {
    this.maxEntries = boundedLimit(options.maxEntries);
    this.filePath = options.filePath?.trim() || null;
  }

  async load(): Promise<void> {
    if (!this.filePath) return;
    try {
      const info = await stat(this.filePath);
      const maxBytes = this.maxEntries * MAX_LINE_BYTES;
      const start = Math.max(0, info.size - maxBytes);
      const handle = await open(this.filePath, 'r');
      let text: string;
      try {
        const bytes = Buffer.alloc(Math.max(0, info.size - start));
        await handle.read(bytes, 0, bytes.length, start);
        text = bytes.toString('utf8');
      } finally {
        await handle.close();
      }
      // Content-bearing diagnostics must never leave an existing permissive
      // file readable by other local users.
      await chmod(this.filePath, 0o600);
      const loaded: RequestDebugEntry[] = [];
      let malformed = !text.endsWith('\n');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const value = normalizeEntry(JSON.parse(line));
          if (value) loaded.push(value); else malformed = true;
        } catch { malformed = true; }
      }
      this.entries = loaded.slice(-this.maxEntries);
      this.persistedLines = this.entries.length;
      if (malformed || loaded.length !== this.entries.length) await this.rewrite();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[dario] debug log load failed: ${(error as Error).message}`);
      }
    }
  }

  add(entry: RequestDebugEntry): void {
    const normalized = normalizeEntry(entry);
    if (!normalized) return;
    this.entries.push(normalized);
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
    if (!this.filePath) return;
    this.persistNeeded = true;
    this.schedulePersist();
  }

  /** Wait for all queued persistence work; called by graceful shutdown/tests. */
  async flush(): Promise<void> { await this.writeChain; }

  /** Per-process fingerprints prevent dictionary attacks and cross-restart correlation. */
  fingerprint(value: string): string {
    return createHash('sha256').update(this.salt).update(value).digest('hex').slice(0, 12);
  }

  recent(limit = this.maxEntries): RequestDebugEntry[] {
    const count = Math.max(1, Math.min(this.maxEntries, Math.floor(limit) || this.maxEntries));
    return this.entries.slice(-count).reverse().map((entry) => ({ ...entry, retryReasons: [...entry.retryReasons], affinitySignals: entry.affinitySignals?.map((s) => ({ ...s })) }));
  }

  size(): number { return this.entries.length; }

  private schedulePersist(): void {
    if (!this.filePath || this.persistScheduled) return;
    this.persistScheduled = true;
    this.writeChain = this.writeChain.then(async () => {
      while (this.persistNeeded) {
        this.persistNeeded = false;
        await chmod(this.filePath!, 0o600).catch(() => {});
        // A single append is cheap; concurrent additions are coalesced into
        // one bounded rewrite instead of one rewrite per request.
        if (this.persistedLines < this.maxEntries && this.entries.length === this.persistedLines + 1) {
          await mkdir(dirname(this.filePath!), { recursive: true });
          await appendFile(this.filePath!, `${JSON.stringify(this.entries.at(-1))}\n`, { mode: 0o600 });
          this.persistedLines++;
        } else {
          await this.rewrite();
        }
      }
      this.persistScheduled = false;
    }).catch((error) => {
      this.persistScheduled = false;
      console.error(`[dario] debug log write failed: ${(error as Error).message}`);
    });
  }

  private async rewrite(): Promise<void> {
    if (!this.filePath) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, this.entries.map((entry) => JSON.stringify(entry)).join('\n') + (this.entries.length ? '\n' : ''), { mode: 0o600 });
    await rename(tmp, this.filePath);
    this.persistedLines = this.entries.length;
  }
}
