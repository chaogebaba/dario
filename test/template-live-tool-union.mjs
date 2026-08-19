#!/usr/bin/env bun
// A fresh live capture must not narrow the bundled tool union.
//
// The bundle is deliberately a SUPERSET. Three separate registries in
// cc-template.ts exist only to keep it one — PLATFORM_ONLY_TOOLS (win32:
// PowerShell/Glob/Grep), INTERACTIVE_ONLY_TOOLS (AskUserQuestion,
// EnterPlanMode, ExitPlanMode; CC v2.1.187 stopped advertising them under
// `--print`) and CONFIG_SCOPED_TOOLS (TaskCreate/Get/List/Update; they come
// and go with CC's remote config) — and scripts/capture-and-bake.mjs merges
// all three forward so a headless re-bake cannot drop them.
//
// None of that protected the RUNTIME. cc-template.ts derives everything from
// `loadTemplate()`, which prefers a live cache under 24h and passed its `tools`
// through untouched. On the audit machine that cache held 24 tools against the
// bundle's 34, and the missing ten were exactly those three sets with no
// remainder — while the 24 they shared were byte-identical and in the same
// order. So the cache contributed nothing and cost ten tools.
//
// The cost is the v4.8.93 regression: CC_NATIVE_NAMES_UNION is derived from the
// loaded template, so a client that declares a dropped tool stops
// identity-mapping, falls into the unmapped round-robin, and is renamed onto a
// fallback slot with junk args.
//
// Order is load-bearing too. The dropped tools sit at INTERIOR bundle indices
// (AskUserQuestion at 1, PowerShell at 17), and buildCCRequest writes template
// order straight onto the wire when the client declares nothing — so the union
// has to rebuild on the bundle's ordering, not append.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Pin the cache path away from the operator's real one BEFORE importing, so
// module init can never read (or be confused by) a real live capture.
process.env.DARIO_LIVE_TEMPLATE_CACHE = join(dirname(fileURLToPath(import.meta.url)), 'does-not-exist.json');

const { withBundledFallbacks } = await import('../dist/live-fingerprint.js');
const { PLATFORM_ONLY_TOOLS, INTERACTIVE_ONLY_TOOLS, CONFIG_SCOPED_TOOLS } =
  await import('../dist/cc-template.js');

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`); }
}
function header(name) { console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`); }

const here = dirname(fileURLToPath(import.meta.url));
const bundle = JSON.parse(readFileSync(join(here, '..', 'dist', 'cc-template-data.json'), 'utf-8'));
const bundleNames = bundle.tools.map((t) => t.name);

// The exact real-world shape: the bundle minus everything a headless POSIX
// capture drops.
const preserved = new Set([
  ...Object.values(PLATFORM_ONLY_TOOLS).flatMap((s) => [...s]),
  ...INTERACTIVE_ONLY_TOOLS,
  ...CONFIG_SCOPED_TOOLS,
]);
const liveish = (over = {}) => ({
  _version: bundle._version,
  _captured: new Date().toISOString(),
  _source: 'live',
  agent_identity: bundle.agent_identity,
  system_prompt: bundle.system_prompt,
  tools: bundle.tools.filter((t) => !preserved.has(t.name)),
  tool_names: bundle.tools.filter((t) => !preserved.has(t.name)).map((t) => t.name),
  ...over,
});

// ======================================================================
header('the preservation sets survive a narrowed live capture');
{
  const live = liveish();
  check('the fixture really is narrower than the bundle',
    live.tools.length < bundle.tools.length,
    `live=${live.tools.length} bundle=${bundle.tools.length}`);
  check('the fixture drops every registered name', [...preserved].every((n) => !live.tool_names.includes(n)));

  const merged = withBundledFallbacks(live);
  const mergedNames = merged.tools.map((t) => t.name);

  for (const name of preserved) {
    check(`${name} survives the merge`, mergedNames.includes(name));
  }
  check('nothing from the bundle is lost',
    bundleNames.every((n) => mergedNames.includes(n)),
    `missing: ${bundleNames.filter((n) => !mergedNames.includes(n)).join(', ')}`);
}

// ======================================================================
header('ordering — the bundle is the spine, not the survivors');
{
  const merged = withBundledFallbacks(liveish());
  const mergedNames = merged.tools.map((t) => t.name);
  // Appending would put AskUserQuestion (bundle index 1) at the end. It must
  // land back at its bundle position, because the no-client-declaration path
  // writes template order onto the wire verbatim.
  check('merged order equals the bundle order exactly',
    JSON.stringify(mergedNames) === JSON.stringify(bundleNames),
    `got ${mergedNames.slice(0, 4).join(',')}… want ${bundleNames.slice(0, 4).join(',')}…`);
  check('an interior tool is restored to its interior index, not appended',
    mergedNames.indexOf('AskUserQuestion') === bundleNames.indexOf('AskUserQuestion'));
}

// ======================================================================
header('tool_names stays derived, never stale');
{
  const merged = withBundledFallbacks(liveish());
  check('tool_names matches tools exactly, in order',
    JSON.stringify(merged.tool_names) === JSON.stringify(merged.tools.map((t) => t.name)),
    `tool_names=${merged.tool_names.length} tools=${merged.tools.length}`);
  // The documented divergence class: the shipped bundle once carried
  // tool_names 30 against tools 33 because a merge updated one and not the
  // other. A consumer trusting tool_names reads a different template.
  check('counts agree', merged.tool_names.length === merged.tools.length);
}

// ======================================================================
header('live still wins where it should');
{
  // A fresher definition of a shared tool supersedes the bake.
  const live = liveish();
  const idx = live.tools.findIndex((t) => t.name === 'Bash');
  live.tools[idx] = { ...live.tools[idx], description: 'LIVE-WINS' };
  const merged = withBundledFallbacks(live);
  check('a live definition of a shared tool supersedes the bundle',
    merged.tools.find((t) => t.name === 'Bash').description === 'LIVE-WINS');

  // A genuinely new tool from a CC newer than the bake is kept — that is the
  // self-healing the live cache exists for.
  const withNew = liveish();
  withNew.tools = [...withNew.tools, { name: 'BrandNewTool', description: 'x', input_schema: {} }];
  withNew.tool_names = withNew.tools.map((t) => t.name);
  const mergedNew = withBundledFallbacks(withNew);
  const names = mergedNew.tools.map((t) => t.name);
  check('a live-only tool is preserved', names.includes('BrandNewTool'));
  check('the live-only tool goes last, after the known spine',
    names[names.length - 1] === 'BrandNewTool');
  check('tool_names still agrees after an addition',
    JSON.stringify(mergedNew.tool_names) === JSON.stringify(names));
}

// ======================================================================
header('degenerate inputs');
{
  const empty = withBundledFallbacks(liveish({ tools: [], tool_names: [] }));
  check('a capture with no tools falls back to the bundle union',
    empty.tools.length === bundle.tools.length);
  check('…and re-derives tool_names for it',
    JSON.stringify(empty.tool_names) === JSON.stringify(bundleNames));
}

// ======================================================================
header('the variants merge it already did still works');
{
  // Regression guard on the behaviour this function was originally added for.
  const merged = withBundledFallbacks(liveish());
  const bundledVariants = bundle.system_prompt_variants ?? {};
  if (Object.keys(bundledVariants).length > 0) {
    check('bundled prompt variants are still carried onto a live capture',
      Object.keys(bundledVariants).every((k) => merged.system_prompt_variants?.[k] !== undefined));
  } else {
    check('bundle carries no variants — nothing to merge (skipped)', true);
  }
  const own = withBundledFallbacks(liveish({ system_prompt_variants: { 'opus-5': 'LIVE-WINS' } }));
  check('a variant the live template already has still wins',
    own.system_prompt_variants['opus-5'] === 'LIVE-WINS');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
