// Build a live-template cache in the shape a real headless capture writes.
//
// The suite used to point every child at a path that does not exist, so
// `loadTemplate` always fell back to the bundle. That kept the run
// independent of local machine state — and made it blind to the
// configuration dario actually runs in, which is the configuration where
// the tool-union regression (a live cache holding 24 of the bundle's 34
// tools) went unnoticed for a release. A suite that only ever sees the
// bundle cannot catch a bug in how live and bundle combine.
//
// So: a cache is present, and it is the realistic one. `claude --print`
// advertises only the tools that mean something without a UI — the plan-mode
// pair, AskUserQuestion, the Task/Cron families, Glob/Grep/Web* are simply
// absent from the request it sends. Measured against CC 2.1.236: twelve of
// the bundle's thirty-four survive, and two the bundle does not carry appear.
//
// Derived from the bundle rather than committed as a 132 KB blob of one
// machine's capture: the shape is what matters, and a derived fixture stays
// valid as the bundle moves instead of rotting into a stale snapshot.

import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Tool names a headless capture on CC 2.1.236 carried. Intersected with the
 * bundle, so a bundle that renames or drops one of these produces a smaller
 * fixture rather than a fixture referencing a tool that no longer exists.
 */
export const HEADLESS_TOOL_NAMES = Object.freeze([
  'Agent', 'Bash', 'DeferredToolPlaceholder', 'Edit', 'ListAgents', 'Read',
  'ReportFindings', 'ScheduleWakeup', 'Skill', 'ToolSearch', 'Workflow', 'Write',
]);

/**
 * Write a headless-shaped live cache to `path`, derived from `bundlePath`.
 * Returns the parsed object so a caller can assert against it.
 *
 * `_captured` is stamped now, so the cache is inside `LIVE_TTL_MS` and
 * actually wins over the bundle — a fixture that silently ages out would
 * restore the old blindness without any test going red.
 */
export function writeHeadlessLiveCache(path, bundlePath) {
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf-8'));
  const keep = new Set(HEADLESS_TOOL_NAMES);
  const tools = bundle.tools.filter((t) => keep.has(t.name));
  const cache = {
    _version: bundle._version,
    _captured: new Date().toISOString(),
    _source: 'live',
    _schemaVersion: bundle._schemaVersion,
    agent_identity: bundle.agent_identity,
    system_prompt: bundle.system_prompt,
    tools,
    tool_names: tools.map((t) => t.name),
    header_order: bundle.header_order,
    anthropic_beta: bundle.anthropic_beta,
    header_values: bundle.header_values,
    body_field_order: bundle.body_field_order,
  };
  writeFileSync(path, JSON.stringify(cache, null, 2));
  return cache;
}
