#!/usr/bin/env bun
// Tests for src/config-file.ts (v4 M1).
//
// Pins the contract every higher-level v4 surface depends on:
//   - defaults stay in sync with v3 CLI flag defaults
//   - missing / corrupt files never abort startup
//   - precedence chain (defaults < file < env < flag) holds in both
//     simple and nested cases
//   - atomic write doesn't leave the .tmp file around on failure
//   - sanitize() drops bad types instead of letting them through
//
// Run: `node test/config-file.mjs` (or via npm test).

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONFIG_SCHEMA_VERSION,
  defaultConfig,
  loadConfig,
  saveConfig,
  mergeOver,
  resolveConfig,
  effectiveApiKey,
  resolveApiKey,
} from '../dist/config-file.js';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  OK ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
}
function header(n) { console.log(`\n=== ${n} ===`); }

// Sandbox: each test that touches disk uses a fresh tmp dir.
function withSandbox(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dario-cfg-'));
  try { fn(dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

// ─────────────────────────────────────────────────────────────
header('defaultConfig() — shape + values');
{
  const d = defaultConfig();
  check('schema version',         d.version === CONFIG_SCHEMA_VERSION);
  check('port = 3456',            d.port === 3456);
  check('host = 127.0.0.1',       d.host === '127.0.0.1');
  check('pacing.minMs = 500',     d.pacing?.minMs === 500);
  check('pacing.jitterMs = 0',    d.pacing?.jitterMs === 0);
  check('thinkTime.maxMs = 30s',  d.thinkTime?.maxMs === 30_000);
  check('session.idleRotateMs = 15min', d.session?.idleRotateMs === 900_000);
  check('session.maxAgeMs null',  d.session?.maxAgeMs === null);
  check('queue.maxConcurrent null', d.queue?.maxConcurrent === null);
  check('passthroughBetas []',    Array.isArray(d.passthroughBetas) && d.passthroughBetas.length === 0);
  check('stealth false',          d.stealth === false);
  check('model null',             d.model === null);
  check('maxTokens null',         d.maxTokens === null);
  check('apiKey null',            d.apiKey === null);
}

header('defaultConfig() — callers receive independent nested values');
{
  const first = defaultConfig();
  const second = defaultConfig();
  first.pacing.minMs = 123;
  first.modelAliases.example = 'model-a';
  first.passthroughBetas.push('beta-a');
  check('nested object is independent', second.pacing.minMs === 500);
  check('record is independent', second.modelAliases.example === undefined);
  check('array is independent', second.passthroughBetas.length === 0);
}

// ─────────────────────────────────────────────────────────────
header('loadConfig — missing file falls through to defaults');
withSandbox((dir) => {
  const result = loadConfig(join(dir, 'config.json'));
  check('source = missing',       result.source === 'missing');
  check('error undefined',        result.error === undefined);
  check('config = defaults',      result.config.port === 3456 && result.config.host === '127.0.0.1');
});

header('effectiveApiKey — environment then persisted config');
withSandbox((dir) => {
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ version: 1, apiKey: 'file-key' }));
  check('persisted key is used without env', effectiveApiKey({}, path) === 'file-key');
  check('environment key wins', effectiveApiKey({ DARIO_API_KEY: 'env-key' }, path) === 'env-key');
  check('empty environment falls through to file', effectiveApiKey({ DARIO_API_KEY: '' }, path) === 'file-key');
});

header('resolveApiKey — already-loaded config uses the same precedence');
{
  const config = { apiKey: 'file-key' };
  check('persisted key is used', resolveApiKey(config, {}) === 'file-key');
  check('environment key wins', resolveApiKey(config, { DARIO_API_KEY: 'env-key' }) === 'env-key');
  check('empty environment falls through', resolveApiKey(config, { DARIO_API_KEY: '' }) === 'file-key');
  check('null config remains unset', resolveApiKey({ apiKey: null }, {}) === undefined);
}

// ─────────────────────────────────────────────────────────────
header('loadConfig — invalid JSON returns defaults + error');
withSandbox((dir) => {
  const path = join(dir, 'config.json');
  writeFileSync(path, '{ this is not valid json');
  const result = loadConfig(path);
  check('source = invalid',       result.source === 'invalid');
  check('error mentions parse',   typeof result.error === 'string' && result.error.toLowerCase().includes('parse'));
  check('falls back to defaults', result.config.port === 3456);
});

// ─────────────────────────────────────────────────────────────
header('loadConfig — top-level array returns defaults');
withSandbox((dir) => {
  const path = join(dir, 'config.json');
  writeFileSync(path, '[1, 2, 3]');
  const result = loadConfig(path);
  check('source = invalid',       result.source === 'invalid');
  check('error mentions array',   typeof result.error === 'string' && result.error.includes('array'));
});

// ─────────────────────────────────────────────────────────────
header('loadConfig — partial file merges over defaults');
withSandbox((dir) => {
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({
    version: 1,
    port: 9999,
    stealth: true,
    pacing: { jitterMs: 250 },  // minMs absent → falls through to default 500
  }));
  const r = loadConfig(path);
  check('source = file',          r.source === 'file');
  check('overridden port',        r.config.port === 9999);
  check('overridden stealth',     r.config.stealth === true);
  check('pacing.jitterMs from file', r.config.pacing?.jitterMs === 250);
  check('pacing.minMs from default', r.config.pacing?.minMs === 500);
  check('unrelated default kept', r.config.host === '127.0.0.1');
});

// ─────────────────────────────────────────────────────────────
header('loadConfig — wrong-type fields are dropped (no abort)');
withSandbox((dir) => {
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({
    version: 1,
    port: 'not-a-number',          // dropped
    host: 99,                       // dropped (number where string expected)
    stealth: 'yes',                 // dropped (not boolean)
    pacing: { minMs: 250 },         // valid, applied
    sessionStart: 'invalid',        // dropped (not an object)
  }));
  const r = loadConfig(path);
  check('port falls back to default',  r.config.port === 3456);
  check('host falls back to default',  r.config.host === '127.0.0.1');
  check('stealth falls back to false', r.config.stealth === false);
  check('pacing.minMs applied',        r.config.pacing?.minMs === 250);
  check('sessionStart default kept',   r.config.sessionStart?.minMs === 0);
});

header('loadConfig — schema sanitizes representative field shapes');
withSandbox((dir) => {
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({
    version: 1,
    apiKey: 'persisted-key',
    preserveTools: true,
    pool: { strategy: 'round-robin' },
    sessionAffinity: { enabled: false, ttlMs: -1 },
    queue: { maxConcurrent: 3, maxQueued: 'invalid', timeoutMs: null },
    modelAliases: { ' FAST ': ' openai:model-a ', empty: ' ' },
    passthroughBetas: ['one', 2, 'two'],
  }));
  const config = loadConfig(path).config;
  check('string-or-null field accepted', config.apiKey === 'persisted-key');
  check('boolean field accepted', config.preserveTools === true);
  check('nested enum accepted', config.pool.strategy === 'round-robin');
  check('invalid non-negative value falls back', config.sessionAffinity.ttlMs === 3_600_000);
  check('nested number accepted', config.queue.maxConcurrent === 3);
  check('invalid nested value falls back', config.queue.maxQueued === null);
  check('explicit nested null accepted', config.queue.timeoutMs === null);
  check('model aliases normalized', config.modelAliases.fast === 'openai:model-a' && config.modelAliases.empty === undefined);
  check('string array filtered', JSON.stringify(config.passthroughBetas) === '["one","two"]');
});

// ─────────────────────────────────────────────────────────────
header('loadConfig — maxTokens special cases (number | "client" | null)');
for (const [in_, exp, name] of [
  [42, 42, 'number'],
  ['client', 'client', '"client" literal'],
  [null, null, 'null'],
  ['banana', null, 'invalid string → fall through to default (null)'],
  [{ nested: true }, null, 'object → fall through'],
]) {
  withSandbox((dir) => {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ version: 1, maxTokens: in_ }));
    const r = loadConfig(path);
    check(`maxTokens ${name}`, r.config.maxTokens === exp,
      `got ${JSON.stringify(r.config.maxTokens)} expected ${JSON.stringify(exp)}`);
  });
}

// ─────────────────────────────────────────────────────────────
header('saveConfig — atomic write + round-trip');
withSandbox((dir) => {
  const path = join(dir, 'subdir-that-does-not-exist', 'config.json');
  const cfg = defaultConfig();
  cfg.port = 8765;
  cfg.stealth = true;
  cfg.apiKey = 'round-trip-secret';
  cfg.pacing = { minMs: 250, jitterMs: 500 };
  saveConfig(path, cfg);
  check('file created',           existsSync(path));
  check('file is readable JSON',  (() => { try { JSON.parse(readFileSync(path, 'utf-8')); return true; } catch { return false; }})());
  // No leftover .tmp.* sibling
  const dirContents = readdirSync(join(dir, 'subdir-that-does-not-exist'));
  check('no leftover .tmp file',  !dirContents.some(f => f.includes('.tmp.')));
  // Round-trip
  const reloaded = loadConfig(path);
  check('round-trip source file', reloaded.source === 'file');
  check('round-trip port',        reloaded.config.port === 8765);
  check('round-trip stealth',     reloaded.config.stealth === true);
  check('round-trip apiKey',      reloaded.config.apiKey === 'round-trip-secret');
  check('round-trip nested',      reloaded.config.pacing?.jitterMs === 500);
});

// ─────────────────────────────────────────────────────────────
header('saveConfig — upgrades old schemas and refuses future schemas');
withSandbox((dir) => {
  const path = join(dir, 'c.json');
  const cfg = defaultConfig();
  cfg.version = 0;
  saveConfig(path, cfg);
  const on_disk = JSON.parse(readFileSync(path, 'utf-8'));
  check('old version is upgraded to the current schema', on_disk.version === CONFIG_SCHEMA_VERSION);
  cfg.version = CONFIG_SCHEMA_VERSION + 1;
  let futureError = '';
  try { saveConfig(path, cfg); } catch (error) { futureError = error.message; }
  const unchanged = JSON.parse(readFileSync(path, 'utf-8'));
  check('future version save is refused', futureError.includes('newer than this dario build'));
  check('refused future save leaves the file unchanged', unchanged.version === CONFIG_SCHEMA_VERSION);
});

// ─────────────────────────────────────────────────────────────
header('mergeOver — precedence (undefined falls through, null overrides)');
{
  const base = { a: 1, b: 2, c: { x: 10, y: 20 }, d: 'keep' };
  const over1 = { a: undefined, b: 99 };
  const m1 = mergeOver(base, over1);
  check('undefined keeps base',   m1.a === 1);
  check('defined overrides base', m1.b === 99);
  check('unrelated kept',         m1.d === 'keep');

  const over2 = { d: null };
  const m2 = mergeOver(base, over2);
  check('null is a real value',   m2.d === null);

  const over3 = { c: { x: 999 } };
  const m3 = mergeOver(base, over3);
  check('nested: overridden key', m3.c.x === 999);
  check('nested: untouched key',  m3.c.y === 20);
}

// ─────────────────────────────────────────────────────────────
header('mergeOver — arrays replace (no element-merge)');
{
  const base = { betas: ['a', 'b', 'c'] };
  const over = { betas: ['x'] };
  const m = mergeOver(base, over);
  check('arrays replaced',        JSON.stringify(m.betas) === '["x"]');
}

// ─────────────────────────────────────────────────────────────
header('resolveConfig — full precedence chain (defaults < file < env < cli)');
withSandbox((dir) => {
  const path = join(dir, 'c.json');
  writeFileSync(path, JSON.stringify({
    version: 1,
    port: 4000,
    stealth: false,
    pacing: { minMs: 100, jitterMs: 50 },
  }));
  const r = resolveConfig({
    path,
    envOverrides: { stealth: true, pacing: { jitterMs: 200 } },  // env wins on stealth + jitter
    cliOverrides: { port: 9999 },                                  // cli wins on port
  });
  check('cli wins on port',       r.config.port === 9999);
  check('env wins on stealth',    r.config.stealth === true);
  check('env wins on jitter',     r.config.pacing?.jitterMs === 200);
  check('file wins on minMs',     r.config.pacing?.minMs === 100);
  check('default fills host',     r.config.host === '127.0.0.1');
});

// ─────────────────────────────────────────────────────────────
header('Future config schemas are readable but never rewritten');
withSandbox((dir) => {
  const path = join(dir, 'c.json');
  const futureConfig = {
    version: 2,
    port: 3456,
    futureSetting: { newThing: true },
    pool: { strategy: { name: 'weighted' }, futurePolicy: 'new' },
  };
  writeFileSync(path, JSON.stringify(futureConfig));
  const r = loadConfig(path);
  let saveError = '';
  try { saveConfig(path, r.config); } catch (error) { saveError = error.message; }
  const reread = JSON.parse(readFileSync(path, 'utf-8'));
  check('compatible future fields remain readable', r.config.port === 3456);
  check('future schema save is refused', saveError.includes('newer than this dario build'));
  check('unknown and reshaped fields remain byte-for-byte intact',
    JSON.stringify(reread) === JSON.stringify(futureConfig));
});

// ─────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
