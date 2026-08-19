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

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Pin the cache path away from the operator's real one BEFORE importing, so
// module init can never read (or be confused by) a real live capture.
process.env.DARIO_LIVE_TEMPLATE_CACHE = join(dirname(fileURLToPath(import.meta.url)), 'does-not-exist.json');

const { withBundledFallbacks, describeTemplate, templateRegression, loadTemplate } =
  await import('../dist/live-fingerprint.js');
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
  // NOT at the end. CC sends tools alphabetically and the bundle is ordered
  // that way; capture-and-bake.mjs sorts after every preservation merge for
  // this reason. Appending would emit an order no real CC sends, in exactly
  // the newer-than-the-bake branch this arm exists to serve.
  check('the live-only tool lands at its alphabetical position, not appended',
    names.indexOf('BrandNewTool') === [...names].sort((a, b) => a.localeCompare(b)).indexOf('BrandNewTool'),
    `at ${names.indexOf('BrandNewTool')} of ${names.length}`);
  check('a live-only tool sorting last still ends up last',
    withBundledFallbacks({
      ...liveish(),
      tools: [...liveish().tools, { name: 'ZzzTool', description: 'x', input_schema: {} }],
    }).tools.map((t) => t.name).at(-1) === 'ZzzTool');
  check('tool_names still agrees after an addition',
    JSON.stringify(mergedNew.tool_names) === JSON.stringify(names));
}

// ======================================================================
header('the alphabetical invariant itself');
{
  // Nothing else in the suite asserts this, yet the whole ordering argument
  // rests on it: buildCCRequest writes template order onto the wire verbatim,
  // and real CC sends tools sorted by name.
  const sorted = [...bundleNames].sort((a, b) => a.localeCompare(b));
  check('the bundle is strictly alphabetical by localeCompare',
    JSON.stringify(bundleNames) === JSON.stringify(sorted),
    `first divergence at ${bundleNames.findIndex((n, i) => n !== sorted[i])}`);
  const merged = withBundledFallbacks(liveish()).tools.map((t) => t.name);
  check('…and the merge preserves it',
    JSON.stringify(merged) === JSON.stringify([...merged].sort((a, b) => a.localeCompare(b))));
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

// ======================================================================
header('the merge reports what it had to supply');
{
  // The union above is a repair, and a repair that leaves no trace is how a
  // halved tool list read as healthy for a release: the startup banner said
  // `live capture … variants: fable+opus-5+sonnet-5` off a cache that carried
  // no variants and ten of thirty-four tools. Every axis it named came from
  // the bundle. `_fromBundle` is what makes that sayable.
  const merged = withBundledFallbacks(liveish());
  check('_fromBundle names the tools the capture lacked',
    JSON.stringify([...merged._fromBundle.tools].sort())
    === JSON.stringify([...preserved].sort()),
    `got ${merged._fromBundle.tools.length}, want ${preserved.size}`);
  check('_fromBundle names the variants the capture lacked',
    JSON.stringify(merged._fromBundle.variants)
    === JSON.stringify(Object.keys(bundle.system_prompt_variants ?? {}).sort()));

  // A capture that carried everything must not be labelled as borrowing.
  const complete = withBundledFallbacks(liveish({
    tools: bundle.tools,
    tool_names: bundleNames,
    system_prompt_variants: { ...(bundle.system_prompt_variants ?? {}) },
  }));
  check('a complete capture borrows no tools', complete._fromBundle.tools.length === 0);
  check('…and no variants', complete._fromBundle.variants.length === 0);

  // The banner is the whole point of the field, so assert the string, not just
  // the field. Counting is not attributing: `tools: 34` was always true.
  const line = describeTemplate(merged);
  check('the banner attributes the borrowed tools',
    line.includes(`tools: ${bundle.tools.length} (${preserved.size} bundled)`), line);
  check('the banner attributes the borrowed variants',
    /variants: [^,]*\(\d+\/\d+ bundled\)/.test(line), line);
  check('a complete capture gets no parenthetical at all',
    !describeTemplate(complete).includes('bundled)'), describeTemplate(complete));
  check('the banner still leads with source, version and age',
    /^live capture, CC v[\d.]+ \(\d+\w+ old\), /.test(line), line);
}

// ======================================================================
header('a template the bundle beats outright is refused, not merged');
{
  // The repair above covers `tools` and `system_prompt_variants`. Nothing
  // repairs `system_prompt` — there is no fallback for it, so a degenerate one
  // wins for the cache's full 24h TTL and the only route back to the bundle is
  // deleting the file by hand. That is the axis this gate exists for.
  check('a healthy capture is accepted', templateRegression(liveish(), bundle) === null);
  check('an empty prompt is refused',
    /system prompt is empty/.test(templateRegression(liveish({ system_prompt: '' }), bundle) ?? ''));
  check('an empty identity is refused',
    /identity block is empty/.test(templateRegression(liveish({ agent_identity: '' }), bundle) ?? ''));
  // The realistic shape of the failure: CC reshuffles its system blocks, so
  // `systemBlocks[2]` is no longer the prompt. Both fields stay non-empty and
  // every other check passes.
  check('the prompt being the identity block is refused',
    templateRegression(liveish({ system_prompt: bundle.agent_identity }), bundle) !== null);
  // The same defect where the two are not byte-equal: block [2] holding the
  // tiny billing tag. CC's prompt is never shorter than its identity line.
  check('a prompt no longer than the identity block is refused',
    templateRegression(liveish({ system_prompt: 'x'.repeat(bundle.agent_identity.length) }), bundle) !== null);
  check('…and one byte longer is not',
    templateRegression(liveish({ system_prompt: 'x'.repeat(bundle.agent_identity.length + 1) }), bundle) === null);

  // The gate is structural on purpose — no size ratio against the bundle. A
  // `--print` capture is narrower than the bundle by construction, and the
  // legitimate prompt spread across model families is 5.7x on this bundle
  // alone, so any ratio interesting enough to add something sits inside the
  // range of correct prompts. These pin that nothing size-based crept back in.
  check('a headless-narrow tool list is NOT a reason to refuse',
    templateRegression(liveish(), bundle) === null,
    `${liveish().tools.length} tools vs bundle ${bundle.tools.length}`);
  check('a short but structurally sound prompt is served, not refused',
    templateRegression(liveish({ system_prompt: `# Harness\n${'x'.repeat(300)}` }), bundle) === null);

  // Not a count test — an identity test. A capture sharing no tool with the
  // bundle did not come from a CC this dario knows.
  check('a capture sharing no tool with the bundle is refused',
    /did not come from a CC/.test(templateRegression(
      liveish({ tools: [{ name: 'Zorp', description: '', input_schema: {} }], tool_names: ['Zorp'] }), bundle) ?? ''));
  check('one shared tool is enough to be recognised',
    templateRegression(liveish({
      tools: [bundle.tools[0], { name: 'Zorp', description: '', input_schema: {} }],
      tool_names: [bundle.tools[0].name, 'Zorp'],
    }), bundle) === null);

  // Returning a reason is not refusing. `loadTemplate` is the seam that acts
  // on the verdict, so drive it: a gate that computed the reason and then
  // merged anyway would leave every assertion above green.
  const solo = mkdtempSync(join(tmpdir(), 'dario-gate-served-'));
  const saved = process.env.DARIO_LIVE_TEMPLATE_CACHE;
  try {
    const cachePath = join(solo, 'cc-template.live.json');
    writeFileSync(cachePath, JSON.stringify(liveish({
      _version: '99.99.99-refused',
      _schemaVersion: bundle._schemaVersion,
      system_prompt: 'x',
    })));
    process.env.DARIO_LIVE_TEMPLATE_CACHE = cachePath;
    const served = loadTemplate({ silent: true });
    check('a refused cache is replaced by the bundle, not served',
      served._version !== '99.99.99-refused' && served._source !== 'live'
      && served.system_prompt === bundle.system_prompt,
      `${served._version} / ${served._source} / ${served.system_prompt.length}B`);

    // Negative control on the same path: the only edit is the prompt, so this
    // pins the gate rather than the schema check or the TTL above it.
    writeFileSync(cachePath, JSON.stringify(liveish({
      _version: '99.99.99-accepted',
      _schemaVersion: bundle._schemaVersion,
    })));
    check('…while a sound cache at the same path is served',
      loadTemplate({ silent: true })._version === '99.99.99-accepted');
  } finally {
    if (saved === undefined) delete process.env.DARIO_LIVE_TEMPLATE_CACHE;
    else process.env.DARIO_LIVE_TEMPLATE_CACHE = saved;
    rmSync(solo, { recursive: true, force: true });
  }

  // The merge itself stays a pure merge and passes a degenerate template
  // straight through — the refusal lives in loadTemplate, which is what
  // decides what to serve. Folding it in here is what broke four suites that
  // build four-byte prompts to exercise the merge.
  const merged = withBundledFallbacks(liveish({ system_prompt: 'x' }));
  check('the merge does not second-guess a degenerate prompt', merged.system_prompt === 'x');
}

// ======================================================================
header('the merge parses the bundle once when handed it');
{
  // loadTemplate loads the 168 KB snapshot to run the gate; passing it through
  // is what keeps the live path from parsing it a second time.
  const sentinel = { ...bundle, system_prompt_variants: { sentinel: 'FROM-THE-PRELOAD' } };
  const merged = withBundledFallbacks(liveish(), sentinel);
  check('a preloaded bundle is the one that is merged',
    merged.system_prompt_variants.sentinel === 'FROM-THE-PRELOAD');
  check('…and the on-disk bundle is not also consulted',
    merged.system_prompt_variants['opus-5'] === undefined,
    Object.keys(merged.system_prompt_variants).join(','));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
