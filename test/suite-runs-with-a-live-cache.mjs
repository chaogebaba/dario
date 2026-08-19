#!/usr/bin/env bun
// The suite must run in the configuration dario runs in.
//
// The driver used to point every child's DARIO_LIVE_TEMPLATE_CACHE at a path
// that did not exist, so loadTemplate always returned the bundle. Half of that
// was right — a test whose result depends on whether you started the proxy an
// hour ago is not measuring the code — and half of it was how the tool-union
// regression survived a release: a live cache holding a fraction of the
// bundle's tools is the production configuration on every machine with CC
// installed, and no suite ever saw it.
//
// The driver now writes a headless-shaped fixture there instead. This file is
// what stops that from silently reverting: a fixture that stops being written,
// stops being loaded, or ages past the TTL would restore the old blindness
// without anything else going red.

import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeHeadlessLiveCache } from './lib/headless-live-cache.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, '..', 'dist', 'cc-template-data.json');

// Driven by the runner, the inherited path is the assertion's subject. Run
// standalone, there is nothing to inherit, so provision the same fixture —
// reaching for the operator's real ~/.dario cache instead is the one thing
// this file must never do.
const driven = typeof process.env.DARIO_LIVE_TEMPLATE_CACHE === 'string'
  && existsSync(process.env.DARIO_LIVE_TEMPLATE_CACHE);
let own;
if (!driven) {
  own = mkdtempSync(join(tmpdir(), 'dario-live-cache-solo-'));
  process.env.DARIO_LIVE_TEMPLATE_CACHE = join(own, 'cc-template.live.json');
  writeHeadlessLiveCache(process.env.DARIO_LIVE_TEMPLATE_CACHE, bundlePath);
  process.on('exit', () => rmSync(own, { recursive: true, force: true }));
}

const { loadTemplate } = await import('../dist/live-fingerprint.js');

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`); }
}
function header(name) { console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`); }

const bundle = JSON.parse(readFileSync(bundlePath, 'utf-8'));
const cache = JSON.parse(readFileSync(process.env.DARIO_LIVE_TEMPLATE_CACHE, 'utf-8'));

header(driven ? 'the inherited fixture (driven by test/all.test.mjs)' : 'a self-provisioned fixture (standalone run)');
{
  check('a live cache is present', cache !== null);
  check('it is narrower than the bundle, the way a headless capture is',
    cache.tools.length < bundle.tools.length, `${cache.tools.length} vs ${bundle.tools.length}`);
  check('it carries no prompt variants, the way a live capture does not',
    cache.system_prompt_variants === undefined);
  // A fixture stamped at bake time rather than at write time would age out of
  // LIVE_TTL_MS and stop winning, restoring the blindness with nothing red.
  check('it is inside the 24h TTL, so it actually wins over the bundle',
    Date.now() - Date.parse(cache._captured) < 24 * 60 * 60 * 1000);
  check('its schema version matches, so readLiveCache does not skip it',
    cache._schemaVersion === bundle._schemaVersion, String(cache._schemaVersion));
}

header('and the loaded template really is the combination');
{
  const t = loadTemplate({ silent: true });
  check('loadTemplate reports the live source', t._source === 'live', String(t._source));
  check('the prompt came from the cache', t.system_prompt === cache.system_prompt);
  check('the tool union was restored to the bundle\'s full set',
    t.tools.length === bundle.tools.length, `${t.tools.length} vs ${bundle.tools.length}`);
  check('and the merge says so', (t._fromBundle?.tools.length ?? 0) > 0,
    JSON.stringify(t._fromBundle?.tools?.slice(0, 3)));
  check('the variants came from the bundle',
    (t._fromBundle?.variants.length ?? 0) === Object.keys(bundle.system_prompt_variants ?? {}).length);
}

header('the driver still provisions one');
{
  // Text, not behaviour — a child process cannot observe its parent's source.
  // The behavioural half is above, and it only runs under the driver; this is
  // the half that survives a standalone run.
  const driver = readFileSync(join(here, 'all.test.mjs'), 'utf-8');
  check('all.test.mjs writes a headless fixture at the inherited cache path',
    /writeHeadlessLiveCache\(suiteTemplateCache,/.test(driver));
  check('…and still exports that path to every child',
    /DARIO_LIVE_TEMPLATE_CACHE: suiteTemplateCache/.test(driver));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
