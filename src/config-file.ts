/**
 * Config file foundation — v4.
 *
 * Persists user-tunable settings to `~/.dario/config.json` so the TUI
 * can read + write them without having to manage shell scripts. Establishes
 * the precedence chain that every effective value passes through:
 *
 *   defaults  <  config.json  <  env var  <  CLI flag
 *
 * Existing CLI flags + env vars continue to work unchanged. The config
 * file is purely additive — a missing file resolves to defaults, exactly
 * as v3 already behaved (since v3 had no config file).
 *
 * Atomic write: write to `config.json.tmp`, fsync, rename. Same primitive
 * shape `atomicWriteJson` in src/live-fingerprint.ts uses for the
 * captured CC template.
 *
 * Unknown keys in the loaded file are preserved for forward compatibility.
 * Known fields are validated best-effort: a corrupt or partial file falls
 * back to defaults rather than aborting the process.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';

import { dirname, join } from 'node:path';
import { homeDir } from './home-dir.js';

/**
 * Bumped on any incompatible shape change. v4.0.0 ships schema v1. A
 * future shape change would either add a new optional field (no bump)
 * or rename / restructure (bump to v2 with a migration in `loadConfig`).
 */
export const CONFIG_SCHEMA_VERSION = 1;

/**
 * Default `~/.dario/config.json` location. Override in tests via
 * `loadConfig(path)` / `saveConfig(path, …)`.
 */
export const DEFAULT_CONFIG_PATH = join(homeDir(), '.dario', 'config.json');

/**
 * Every user-tunable setting. Grouped into sub-objects when the knobs
 * cluster naturally (pacing, thinkTime, session, queue) so the TUI's
 * Config tab can render each cluster as a folder without extra glue.
 *
 * Optional everywhere — a partially-populated config file is valid; the
 * proxy fills in defaults for whatever's absent.
 */
export interface DarioConfig {
  /** Schema version of this file. Required for forward-compat. */
  version: number;

  // Networking
  port?: number;
  host?: string;

  // Mode selectors
  model?: string | null;
  passthrough?: boolean;
  preserveTools?: boolean;
  hybridTools?: boolean;
  mergeTools?: boolean;
  noAutoDetect?: boolean;

  // Fingerprint / TLS
  strictTls?: boolean;
  strictTemplate?: boolean;
  noLiveCapture?: boolean;
  drainOnClose?: boolean;

  // Behavioral stealth — single-flag preset that nudges the clusters
  // below away from zero
  stealth?: boolean;

  // Pacing — floor + jitter between upstream requests
  pacing?: {
    minMs?: number;
    jitterMs?: number;
  };

  // Think time — post-response read-time before the next request
  thinkTime?: {
    baseMs?: number;
    perTokenMs?: number;
    jitterMs?: number;
    maxMs?: number;
  };

  // Session start — one-shot startup latency
  sessionStart?: {
    minMs?: number;
    jitterMs?: number;
  };

  // Session lifecycle
  session?: {
    idleRotateMs?: number;
    rotateJitterMs?: number;
    maxAgeMs?: number | null;
    perClient?: boolean;
  };

  // Request queue
  queue?: {
    maxConcurrent?: number | null;
    maxQueued?: number | null;
    timeoutMs?: number | null;
  };

  // Account pool routing
  pool?: {
    /**
     * `headroom` (default) spreads new conversations to the seat with the
     * most headroom; `fill-first` concentrates them on the alphabetically-
     * first eligible seat until it drains to the 2% floor, then spills to
     * the next — primary/backup semantics, alias order is the knob.
     */
    strategy?: 'headroom' | 'fill-first' | 'round-robin';
  };

  // Session affinity — pin multi-turn conversations to one account for
  // prompt-cache locality. Reuses the existing sticky-binding mechanism.
  sessionAffinity?: {
    /** Enable session affinity routing. Default true. */
    enabled?: boolean;
    /** Idle TTL in milliseconds before a binding is reaped. Default 3600000 (1h). */
    ttlMs?: number;
    /** Preferred Claude identity when header and body disagree. */
    claudeSessionSource?: 'header' | 'body';
  };

  // Per-request overrides
  effort?: string | null;
  maxTokens?: number | 'client' | null;

  /**
   * Pool-exhausted fallback. When `model` is a non-empty string and an
   * openai-compat backend is configured, OpenAI-shape requests that the
   * Claude pool can't serve are forwarded to that backend as `model`
   * (response marked `x-dario-pool-fallback`) instead of surfacing the
   * 429/503. Null/absent = off.
   */
  poolFallback?: {
    model?: string | null;
  };

  /**
   * User-defined model aliases: client-visible name → target model.
   * Resolved at request time before provider-prefix parsing, so a target
   * may carry a prefix (`"my-fast": "openai:gpt-4o-mini"`). Names are
   * matched case-insensitively; one step, never recursive.
   */
  modelAliases?: Record<string, string>;

  // Beta flag allow-list (always-forward)
  passthroughBetas?: string[];

  // Custom system prompt resolver — verbatim | partial | aggressive | <file path>
  systemPrompt?: string | null;

  preserveOrchestrationTags?: boolean;

  // Diagnostics
  logFile?: string | null;

  /**
   * Egress proxy for all upstream fetches — `http://`, `https://`,
   * `socks5h://` (DNS resolved at the proxy) or `socks5://` (DNS
   * resolved locally). Credentials may be embedded in the URL.
   * Overridden by `--egress-proxy` and `DARIO_EGRESS_PROXY`.
   */
  egressProxy?: string | null;

  /**
   * API key for authenticating inbound requests to the proxy. Same as
   * setting `DARIO_API_KEY` in the environment but persisted in the
   * config file. Precedence: env `DARIO_API_KEY` > config file > none.
   */
  apiKey?: string | null;

  /**
   * Endpoint asked "what address do you see?" to verify the egress proxy
   * is really carrying traffic. Empty/unset uses Cloudflare's cdn-cgi
   * trace. Overridden by `DARIO_EGRESS_IP_URL`.
   */
  egressIpUrl?: string | null;

  /**
   * Overage-guard — halt the proxy on the first response carrying
   * `representative-claim: overage`. Subscribers should never see a
   * single overage hit during normal operation; one means something
   * is wrong (wire-shape drift, classifier change, account misconfig)
   * and continuing to forward requests bleeds against per-token
   * billing. See dario#288.
   *
   * `behavior: 'halt'`  — return 503 with an Anthropic-shaped error
   *                       body until cooldown expires or `dario resume`
   *                       runs. Default.
   * `behavior: 'warn'`  — emit the SSE event + OS notification but
   *                       leave proxy behavior unchanged.
   *
   * `cooldownMs` — auto-resume delay after a halt. 30 min default.
   *
   * `notifyOs` — best-effort native desktop notification on halt
   *              (osascript/notify-send/BurntToast); terminal BEL is
   *              the unconditional floor.
   */
  overageGuard?: {
    enabled?: boolean;
    behavior?: 'halt' | 'warn';
    cooldownMs?: number;
    notifyOs?: boolean;
  };
}

/**
 * Defaults match the v3.x CLI flag defaults exactly. Any value not
 * specified in config.json resolves to its corresponding default here.
 * Updates to a flag default MUST land here too so they stay in sync.
 */
const CONFIG_DEFAULTS: DarioConfig = {
  version: CONFIG_SCHEMA_VERSION,
  port: 3456,
  host: '127.0.0.1',
  model: null,
  passthrough: false,
  preserveTools: false,
  hybridTools: false,
  mergeTools: false,
  noAutoDetect: false,
  strictTls: false,
  strictTemplate: false,
  noLiveCapture: false,
  drainOnClose: false,
  stealth: false,
  pacing: { minMs: 500, jitterMs: 0 },
  thinkTime: { baseMs: 0, perTokenMs: 0, jitterMs: 0, maxMs: 30_000 },
  sessionStart: { minMs: 0, jitterMs: 0 },
  session: {
    idleRotateMs: 900_000,
    rotateJitterMs: 0,
    maxAgeMs: null,
    perClient: false,
  },
  queue: { maxConcurrent: null, maxQueued: null, timeoutMs: null },
  pool: { strategy: 'headroom' },
  sessionAffinity: { enabled: true, ttlMs: 3_600_000, claudeSessionSource: 'header' },
  effort: null,
  maxTokens: null,
  poolFallback: { model: null },
  modelAliases: {},
  passthroughBetas: [],
  systemPrompt: null,
  preserveOrchestrationTags: false,
  logFile: null,
  egressProxy: null,
  apiKey: null,
  egressIpUrl: null,
  overageGuard: {
    enabled: true,
    behavior: 'halt',
    cooldownMs: 30 * 60 * 1000,
    notifyOs: true,
  },
};

/** Return an independent copy so callers can safely edit nested groups. */
export function defaultConfig(): DarioConfig {
  return structuredClone(CONFIG_DEFAULTS);
}

/**
 * Load the config file at `path` (default ~/.dario/config.json).
 *
 * Returns `{ config, source }` where `source` describes the load outcome
 * for the caller's UI:
 *
 *   - 'file'    — successfully loaded
 *   - 'missing' — file doesn't exist; defaults returned (not an error)
 *   - 'invalid' — file exists but parse / shape check failed; defaults
 *                 returned. The TUI surfaces this so the user knows
 *                 their saved settings were ignored.
 *
 * The loaded shape is type-checked field-by-field: unknown keys pass through
 * while known keys with wrong types are dropped.
 * Strict validation would force a config migration on every shape
 * tweak; loose-but-typed lets the file evolve without breaking older
 * dario installs that haven't been restarted.
 */
export function loadConfig(path: string = DEFAULT_CONFIG_PATH): {
  config: DarioConfig;
  source: 'file' | 'missing' | 'invalid';
  error?: string;
} {
  if (!existsSync(path)) {
    return { config: defaultConfig(), source: 'missing' };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    return {
      config: defaultConfig(),
      source: 'invalid',
      error: `read failed: ${(err as Error).message}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      config: defaultConfig(),
      source: 'invalid',
      error: `JSON parse failed: ${(err as Error).message}`,
    };
  }
  if (!isPlainObject(parsed)) {
    return {
      config: defaultConfig(),
      source: 'invalid',
      error: `top-level value is not an object (got ${Array.isArray(parsed) ? 'array' : typeof parsed})`,
    };
  }
  // Future schema bumps: dispatch on parsed.version here and run the
  // appropriate migration. For now we accept any version field but
  // pass the rest through field-by-field validation.
  const typed = sanitize(parsed as Record<string, unknown>);
  // Merge over defaults so callers always get a fully-populated shape.
  return {
    config: mergeOver(defaultConfig(), typed),
    source: 'file',
  };
}

/**
 * Atomically write `config` to `path`. Writes to `<path>.tmp`, then
 * renames into place — guarantees a reader never observes a half-written
 * file. Creates parent directories if missing.
 *
 * Throws on permission / disk failures (caller handles + surfaces to
 * the TUI's status line). Does NOT throw on a no-op rewrite of the
 * same content; that's a cheap idempotent path.
 */
export function saveConfig(
  path: string = DEFAULT_CONFIG_PATH,
  config: DarioConfig,
): void {
  if (config.version > CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `config schema v${config.version} is newer than this dario build (v${CONFIG_SCHEMA_VERSION}); upgrade dario before saving`,
    );
  }
  const parent = dirname(path);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
  }
  const json = JSON.stringify(
    { ...config, version: CONFIG_SCHEMA_VERSION },
    null,
    2,
  ) + '\n';
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, json, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    // Best-effort cleanup of the temp file so we don't leave debris.
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Deep-merge `over` into `base`, preferring `over` values where defined.
 * Nested objects are merged recursively; arrays and primitives are
 * replaced wholesale (no array-element merge — that'd be surprising).
 *
 * `undefined` in `over` is treated as "absent" and falls through to
 * the `base` value. `null` is a real value and overrides.
 */
export function mergeOver<T extends object>(base: T, over: Partial<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    if (isPlainObject(v) && isPlainObject(out[k])) {
      // Recurse into nested object groups (pacing, thinkTime, …) so a
      // partial override on one sub-field doesn't wipe siblings.
      out[k] = mergeOver(
        out[k] as Record<string, unknown>,
        v as Partial<Record<string, unknown>>,
      );
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/**
 * Resolve the effective config: load file, layer env vars on top, layer
 * CLI flags on top.
 *
 *   defaults  <  config.json  <  env  <  cli
 *
 * `cliOverrides` and `envOverrides` are partial — only the keys the
 * caller actually wants to override should be set. `undefined` keys
 * are skipped, so the existing flag parsers in cli.ts can pass through
 * their normalized output without filtering nulls.
 */
export function resolveConfig(opts: {
  path?: string;
  envOverrides?: Partial<DarioConfig>;
  cliOverrides?: Partial<DarioConfig>;
}): { config: DarioConfig; source: 'file' | 'missing' | 'invalid'; error?: string } {
  const fromFile = loadConfig(opts.path);
  const withEnv = mergeOver(fromFile.config, opts.envOverrides ?? {});
  const withCli = mergeOver(withEnv, opts.cliOverrides ?? {});
  return { ...fromFile, config: withCli };
}

/** Effective proxy/client key: non-empty environment value, then config file. */
export function effectiveApiKey(
  env: NodeJS.ProcessEnv = process.env,
  path?: string,
): string | undefined {
  return resolveApiKey(loadConfig(path).config, env);
}

/** Resolve API-key precedence when the persisted config is already loaded. */
export function resolveApiKey(
  config: Pick<DarioConfig, 'apiKey'>,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env['DARIO_API_KEY'] || config.apiKey || undefined;
}

// ── schema + sanitization ────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

type ValueSanitizer = (value: unknown) => unknown | undefined;

const numberValue: ValueSanitizer = (value) =>
  typeof value === 'number' ? value : undefined;
const finiteNumber: ValueSanitizer = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const nonNegativeNumber: ValueSanitizer = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const booleanValue: ValueSanitizer = (value) =>
  typeof value === 'boolean' ? value : undefined;
const stringValue: ValueSanitizer = (value) =>
  typeof value === 'string' ? value : undefined;
const stringOrNull: ValueSanitizer = (value) =>
  value === null || typeof value === 'string' ? value : undefined;
const numberOrNull: ValueSanitizer = (value) =>
  value === null || (typeof value === 'number' && Number.isFinite(value)) ? value : undefined;
const anyNumberOrNull: ValueSanitizer = (value) =>
  value === null || typeof value === 'number' ? value : undefined;

function enumValue<const T extends string>(...allowed: T[]): ValueSanitizer {
  const values = new Set<unknown>(allowed);
  return (value) => values.has(value) ? value : undefined;
}

function objectValue(fields: Record<string, ValueSanitizer>): ValueSanitizer {
  return (value) => {
    if (!isPlainObject(value)) return undefined;
    const out: Record<string, unknown> = { ...value };
    for (const [key, sanitizer] of Object.entries(fields)) {
      const sanitized = sanitizer(value[key]);
      if (sanitized === undefined) delete out[key];
      else out[key] = sanitized;
    }
    return out;
  };
}

const modelAliasesValue: ValueSanitizer = (value) => {
  if (!isPlainObject(value)) return undefined;
  const aliases: Record<string, string> = {};
  for (const [key, targetValue] of Object.entries(value)) {
    if (typeof targetValue !== 'string') continue;
    const name = key.trim().toLowerCase();
    const target = targetValue.trim();
    if (name && target) aliases[name] = target;
  }
  return aliases;
};

const CONFIG_FIELD_SANITIZERS = {
  version: numberValue,
  port: finiteNumber,
  host: stringValue,
  model: stringOrNull,
  passthrough: booleanValue,
  preserveTools: booleanValue,
  hybridTools: booleanValue,
  mergeTools: booleanValue,
  noAutoDetect: booleanValue,
  strictTls: booleanValue,
  strictTemplate: booleanValue,
  noLiveCapture: booleanValue,
  drainOnClose: booleanValue,
  stealth: booleanValue,
  pacing: objectValue({ minMs: numberValue, jitterMs: numberValue }),
  thinkTime: objectValue({
    baseMs: numberValue,
    perTokenMs: numberValue,
    jitterMs: numberValue,
    maxMs: numberValue,
  }),
  sessionStart: objectValue({ minMs: numberValue, jitterMs: numberValue }),
  session: objectValue({
    idleRotateMs: numberValue,
    rotateJitterMs: numberValue,
    maxAgeMs: anyNumberOrNull,
    perClient: booleanValue,
  }),
  queue: objectValue({
    maxConcurrent: numberOrNull,
    maxQueued: numberOrNull,
    timeoutMs: numberOrNull,
  }),
  pool: objectValue({ strategy: enumValue('headroom', 'fill-first', 'round-robin') }),
  sessionAffinity: objectValue({
    enabled: booleanValue,
    ttlMs: nonNegativeNumber,
    claudeSessionSource: enumValue('header', 'body'),
  }),
  effort: stringOrNull,
  maxTokens: (value) =>
    value === null || value === 'client' ? value : finiteNumber(value),
  poolFallback: objectValue({ model: stringOrNull }),
  modelAliases: modelAliasesValue,
  passthroughBetas: (value) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined,
  systemPrompt: stringOrNull,
  preserveOrchestrationTags: booleanValue,
  logFile: stringOrNull,
  egressProxy: stringOrNull,
  apiKey: stringOrNull,
  egressIpUrl: stringOrNull,
  overageGuard: objectValue({
    enabled: booleanValue,
    behavior: enumValue('halt', 'warn'),
    cooldownMs: nonNegativeNumber,
    notifyOs: booleanValue,
  }),
} satisfies Record<keyof DarioConfig, ValueSanitizer>;

/** Preserve unknown fields and drop ill-typed known fields. */
function sanitize(parsed: Record<string, unknown>): DarioConfig {
  const out: Record<string, unknown> = { ...parsed, version: CONFIG_SCHEMA_VERSION };
  for (const [key, sanitizer] of Object.entries(CONFIG_FIELD_SANITIZERS)) {
    const value = sanitizer(parsed[key]);
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out as unknown as DarioConfig;
}
