/**
 * Live fingerprint extraction.
 *
 * At dario startup, spawn the user's actual `claude` binary against a
 * loopback MITM endpoint, capture the outbound /v1/messages request, and
 * use the captured system prompt / tools / agent identity as the template
 * replay source — instead of shipping a stale snapshot in
 * `cc-template-data.json`.
 *
 * The bundled snapshot remains as a fallback for users without CC installed
 * or when live capture fails. Template replay auto-heals on CC updates
 * without any user action.
 *
 * Security: the MITM endpoint only accepts connections from 127.0.0.1 and
 * only runs long enough to capture a single request. CC's OAuth token
 * never leaves the machine — we send CC to a loopback URL that CC itself
 * trusts because we set ANTHROPIC_BASE_URL in the child's environment.
 *
 * Setting it in the environment is necessary but NOT sufficient: CC's
 * `settings.json` `env` block overrides the inherited environment, so an
 * operator running behind a router proxy would send the capture upstream
 * for real — billing their subscription for a probe that is supposed to be
 * free, while the MITM reported the same "no request arrived" as a machine
 * with no CC installed. The spawn therefore relocates CLAUDE_CONFIG_DIR to
 * a throwaway dir so no settings.json is in scope at all.
 *
 * --------------------------------------------------------------------
 * "Hide in the population" roadmap (v3.13 → ?)
 * --------------------------------------------------------------------
 *
 * The fingerprint pipeline has historically cared about one axis: what
 * goes INSIDE the /v1/messages body (agent identity, system prompt, tool
 * list). That's only one fingerprint vector. Anthropic can (and likely
 * does) look at several others:
 *
 *   1. Header ORDER. Node's http module emits headers in alphabetical
 *      order via setHeader(). Undici preserves insertion order. Real CC
 *      uses undici with a specific insertion pattern. If dario sends
 *      headers in a different order than CC, the difference is trivially
 *      observable on the server side via the raw header array.
 *      → Captured as `header_order` below. Outbound proxy paths should
 *        use the captured order when rebuilding fetch() headers.
 *
 *   2. TLS ClientHello (JA3 / JA4 fingerprint). The cipher list, elliptic
 *      curves, extension order, and ALPN negotiation are determined by
 *      the TLS library, and Node's TLS (OpenSSL) produces a distinctive
 *      fingerprint that differs from any browser or from curl. Real CC
 *      running on top of Node has the Node JA3 — so we already match,
 *      provided both run on the same Node major. A cross-runtime worry
 *      surfaces when Anthropic ships Bun- or bundled-binary CC: at that
 *      point Node-dario and Bun-CC would JA-differ.
 *      → Mitigation: dario requires Bun, whose BoringSSL ClientHello matches
 *        CC's; `--strict-tls` refuses to start on a Bun version below the
 *        JA3-verified floor.
 *
 *   3. HTTP/2 frame ordering + SETTINGS parameters. Similar to TLS, this
 *      is controlled by the HTTP library. Node and undici produce a
 *      consistent H2 fingerprint. Matches as long as both ends run the
 *      same library.
 *
 *   4. Request timing distribution. Real CC sends requests with jitter
 *      driven by user typing, tool-call sequencing, and internal retry
 *      logic. Dario-through-a-client sends requests with jitter driven
 *      by WHATEVER client is on the other end (OpenClaw, Hermes, curl).
 *      That distribution differs from CC's. Anthropic could pattern-match
 *      "no inter-request jitter" as a fingerprint for automated usage.
 *      → Deferred. Adds latency for debatable gain. Analytics already
 *        tracks per-request timing — could drive a replay distribution
 *        later.
 *
 *   5. sessionId rotation cadence. CC rotates its internal session id
 *      on a specific cadence (observed: roughly once per conversation
 *      start, not per-request). Dario today uses a static session id
 *      from loadClaudeIdentity. A proxy that kept rotating sessionId
 *      randomly would stand out; a proxy that never rotates also stands
 *      out. Matching CC's cadence requires observing CC over a longer
 *      period than a single capture session.
 *      → Deferred. Requires a longer-running capture mode.
 *
 *   6. Request body field ordering. JSON is unordered, but the wire
 *      serialization IS ordered. Real CC uses a specific field order
 *      for /v1/messages (e.g., `model` before `messages` before
 *      `system` before `tools`). A proxy that serializes in a different
 *      order leaks its origin.
 *      → Worth matching. Cheap to implement — the template capture
 *        already produces a body we can walk to recover field order.
 *        Deferred to a follow-up.
 *
 * The concrete v3.13 move is (1): capture header_order and make it
 * available on the template so the outbound proxy paths can reproduce
 * it. Everything else is documented here as a roadmap so the next
 * contributor — or dario maintainer six months from now — can pick up
 * the right piece without re-deriving the threat model.
 */

import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeDir } from './home-dir.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Cache-file schema version. Bump when `TemplateData` gains a required
 * field or changes shape in a way that would make older caches produce
 * wrong behavior if loaded verbatim. Mismatched caches are rejected at
 * load time so the fallback + next background refresh write a fresh one.
 */
export const CURRENT_SCHEMA_VERSION = 3;

export interface TemplateData {
  _version: string;
  _captured: string;
  _source?: 'bundled' | 'live';
  _schemaVersion?: number;
  agent_identity: string;
  system_prompt: string;
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  tool_names: string[];
  /**
   * The exact order CC emitted HTTP headers in when it hit the capture
   * endpoint. Lowercased. Populated only from live captures — bundled
   * snapshots leave this undefined and callers fall back to their own
   * default order. Used by outbound proxy paths to reproduce CC's
   * header ordering instead of Node's alphabetical default.
   */
  header_order?: string[];
  /**
   * The `anthropic-beta` flag set CC sent on the captured request, verbatim.
   * Schema v2 (v3.19). Previously the proxy path hardcoded this — bumping
   * CC's beta list required a dario release. Now the proxy replays
   * whatever the live capture recorded. Falls back to
   * `'claude-code-20250219'` when undefined (bundled snapshots, older caches).
   */
  anthropic_beta?: string;
  /**
   * Selected static headers CC sent on the captured request. Scoped to
   * fingerprint-relevant keys — values that CC sets identically on every
   * request and that don't change per session (user-agent, anthropic-version,
   * x-app, x-stainless-*). Excludes auth (authorization), body-framing
   * (content-type, content-length, host), and session-scoped identifiers
   * (x-claude-code-session-id, x-client-request-id). Schema v2.
   */
  header_values?: Record<string, string>;
  /**
   * Top-level JSON key order from the captured /v1/messages body, in the
   * order CC emitted them. JSON is unordered as a type but the wire
   * serialization IS ordered — every field in the body is a potential
   * fingerprint if the order differs from CC's. Schema v3 (v3.22).
   *
   * Previously the proxy hardcoded the order as a comment in buildCCRequest;
   * replaying from the live capture means bumping CC's field order (or
   * adding a new field like `output_config`) no longer requires a dario
   * release. Falls back to the hardcoded build order when undefined.
   */
  body_field_order?: string[];
  /**
   * The newest installed-CC version this template snapshot has been verified
   * against. Present only on bundled snapshots (set by scripts/capture-and-bake.mjs
   * at bake time); absent on live captures (the live `_version` is already
   * the installed CC's version by construction). When a user runs a dario
   * release whose bundled fallback is meaningfully older than their installed
   * CC and live capture fails, loadTemplate warns using this field so the
   * operator knows they're on a stale shape. dario#76.
   */
  _supportedMaxTested?: string;
  /**
   * Per-model system-prompt variants, keyed by family token (`fable`,
   * `opus-5`, `sonnet-5`). CC ships several models a materially different
   * prompt than the shared base — measured on CC 2.1.220 (2026-07-25),
   * two byte-identical passes each: base (opus-4-8) 6664 chars, opus-5
   * 9990, sonnet-5 28156, fable-5 11084. Only variants that DIFFER from
   * the base are stored; a missing key falls back to the base.
   *
   * Populated by the bake only. A live capture is a single request on a
   * single model and can never produce this map, which is why loadTemplate
   * carries it forward from the bundle instead of letting the live cache
   * shadow it.
   */
  system_prompt_variants?: Record<string, string>;
  /**
   * Legacy single-variant slot, pre-variants-map bundles and any live cache
   * file written by an older dario. Folded into the map by promptVariantsOf().
   */
  system_prompt_fable?: string;
  /**
   * What the BUNDLE supplied because the live capture did not carry it.
   * Stamped by `withBundledFallbacks`; DERIVED, never persisted — the cache
   * file records what was captured, and the union is recomputed against
   * whatever bundle is shipped at read time, which is what lets a bundle
   * that drops a tool actually drop it.
   *
   * Exists so the startup banner can attribute each axis. It used to report
   * `variants: fable+opus-5+sonnet-5` off a live cache that carried no
   * variants and ten of the bundle's thirty-four tools — every word after
   * "live capture" came from the bundle, and the one axis it named was the
   * one axis with carry-forward protection.
   */
  _fromBundle?: { tools: string[]; variants: string[] };
}

/**
 * The model both the bake and the runtime capture pin for the SHARED BASE
 * prompt. Without a pin, `claude --print` uses whichever model the user
 * configured as their default, so the captured "base" varied per machine
 * (this box defaults to Opus 5, whose prompt is ~50% larger than
 * opus-4-8's). Per-model divergence belongs in system_prompt_variants,
 * not in an uncontrolled base. capture-and-bake imports this so the two
 * paths cannot drift apart.
 */
export const TEMPLATE_BASE_MODEL = 'claude-opus-4-8';

/**
 * One model family CC ships a distinct system prompt to (dario#lock-step).
 */
export interface VariantFamily {
  /** Key into `system_prompt_variants`. */
  key: string;
  /** Model id the bake pins (via ANTHROPIC_MODEL) to capture this family. */
  captureModel: string;
  /** True when a lowercased model id belongs to this family. */
  matches: (model: string) => boolean;
  /**
   * Set on a family added to this table AFTER the shipped bundle was baked.
   *
   * The bundle can only gain a variant through `capture-and-bake`, and that
   * script also stamps `_supportedMaxTested`, which the cc-drift bot owns — so
   * a family added by hand cannot be filled in by the same commit without
   * racing the bot. The drift check reports the absence, the bot's next bake
   * supplies the text, and until then the family resolves to the base exactly
   * as it did before it was named here. A live capture fills it immediately.
   *
   * The invariant suite treats the flag as a licence for one specific absence
   * and fails once the bake lands, so it cannot outlive its reason.
   */
  awaitingFirstBake?: true;
}

/**
 * The model families CC ships a DIFFERENT system prompt than the shared
 * base, in matcher-precedence order (first match wins — fable stays ahead
 * of the `-5` arms so a hypothetical fable-5 never falls into them).
 *
 * This table is the single source of truth for dario#lock-step: the
 * runtime selection (cc-template.ts:systemPromptForModel), the bake's
 * capture loop (scripts/capture-and-bake.mjs), the doctor's coverage row,
 * and the template invariants all derive from it — the same reason
 * TEMPLATE_BASE_MODEL lives here. Before this table, the bake's model
 * list and the selection arms were maintained by hand in two files, the
 * exact divergence class that shipped tool_names ≠ tools twice.
 *
 * Adding a family here is safe even if it turns out to share the base
 * prompt: the bake stores a variant only when the capture differs.
 */
export const VARIANT_FAMILIES: readonly VariantFamily[] = [
  { key: 'fable', captureModel: 'claude-fable-5', matches: (m) => m.includes('fable') },
  // `-5` bounded so a future opus-50 doesn't match, and so the `[1m]` tag
  // (which is not a digit) still does.
  { key: 'opus-5', captureModel: 'claude-opus-5', matches: (m) => /opus-5(?!\d)/.test(m) },
  { key: 'sonnet-5', captureModel: 'claude-sonnet-5', matches: (m) => /sonnet-5(?!\d)/.test(m) },
  // Haiku is the largest divergence of the four and was missing from this
  // table entirely, so every haiku request was served the 6.2K base where CC
  // sends 27.7K. Measured against CC 2.1.236 on a sandbox capture: haiku's
  // prompt is sonnet-5's long-form prompt plus a TaskCreate planning line,
  // with its own cutoff (February 2025, against the base's January 2026).
  // Matched on the family word rather than a pinned version so 4.5 and any
  // later haiku both land here — the capture model is what decides the text.
  { key: 'haiku', captureModel: 'claude-haiku-4-5-20251001', matches: (m) => m.includes('haiku'), awaitingFirstBake: true },
];

/**
 * Families from VARIANT_FAMILIES that `t` carries no variant for — i.e.
 * models that would silently get the shared BASE prompt instead of CC's
 * model-specific one. Non-empty on a healthy current bundle means the
 * lock-step is degraded: a bad bake, an unreadable bundle behind a live
 * capture, or a pre-variants live cache shadowing the bundle.
 */
export function missingVariantFamilies(t: TemplateData): string[] {
  const have = promptVariantsOf(t);
  return VARIANT_FAMILIES.filter((f) => !(typeof have[f.key] === 'string' && have[f.key].length > 0))
    .map((f) => f.key);
}

/**
 * A template's prompt variants, with the legacy `system_prompt_fable` slot
 * folded in under the `fable` key. Callers should always go through this
 * rather than reading either field directly.
 */
export function promptVariantsOf(t: TemplateData): Record<string, string> {
  const out: Record<string, string> = { ...(t.system_prompt_variants ?? {}) };
  if (out.fable === undefined && typeof t.system_prompt_fable === 'string' && t.system_prompt_fable.length > 0) {
    out.fable = t.system_prompt_fable;
  }
  return out;
}

/**
 * Rebuild the tool list on the BUNDLE's ordering, preferring live definitions.
 *
 * The bundle is deliberately a superset: PLATFORM_ONLY_TOOLS,
 * INTERACTIVE_ONLY_TOOLS and CONFIG_SCOPED_TOOLS in cc-template.ts each exist
 * so a headless auto-rebake cannot narrow it, and each records the regression
 * that motivated it. A live capture is narrower by construction — headless,
 * one platform, whatever CC's remote config served that minute — so taking its
 * `tools` verbatim throws all three defenses away.
 *
 * Bundle order is the spine rather than live's, because the tools a headless
 * capture drops sit at INTERIOR positions (AskUserQuestion at index 1,
 * PowerShell at 17). buildCCRequest writes template order straight onto the
 * wire in the no-client-declaration path (proxy.ts), so appending the
 * survivors would emit an order no real CC sends.
 */
function unionToolsOnBundleOrder(
  live: TemplateData['tools'] | undefined,
  bundled: TemplateData['tools'] | undefined,
): TemplateData['tools'] | null {
  if (!Array.isArray(bundled) || bundled.length === 0) return null;
  if (!Array.isArray(live) || live.length === 0) return bundled;
  const liveByName = new Map(live.map((t) => [t.name, t]));
  const bundledNames = new Set(bundled.map((t) => t.name));
  // Live's definition wins where both carry the tool, matching how the prompt
  // variants below resolve a collision: a fresher schema supersedes the bake.
  const out = bundled.map((t) => liveByName.get(t.name) ?? t);
  // A tool live has and the bundle does not is genuinely new — a CC that
  // shipped after the last bake. Keeping it is the self-healing the live cache
  // exists for.
  //
  // It goes at its ALPHABETICAL position, not at the end. CC sends tools sorted
  // by name — the bundle is strictly ordered by localeCompare, and
  // capture-and-bake.mjs:211 sorts after each of its three preservation merges
  // for exactly this reason. Appending instead would emit `…Workflow, Write,
  // Bookmark` where real CC sends Bookmark at index 3, and it would do it in
  // precisely the branch this arm exists to serve: a CC newer than the last
  // bake, on the no-client-declaration paths that write template order onto the
  // wire verbatim. Same defect as taking live's order wholesale, one tool wide.
  //
  // Spliced per tool rather than sorting `out`, so a future bundle that is
  // deliberately not alphabetical keeps its spine byte-exact instead of being
  // silently re-sorted under us.
  for (const tool of live) {
    if (bundledNames.has(tool.name)) continue;
    const at = out.findIndex((t) => t.name.localeCompare(tool.name) > 0);
    if (at === -1) out.push(tool);
    else out.splice(at, 0, tool);
  }
  return out;
}

/**
 * Carry the bundle's prompt variants and tool union onto a live-captured
 * template.
 *
 * loadTemplate used to return the live cache verbatim, and a live capture
 * carries no variants — so a fresh cache silently reverted every
 * model-specific prompt to the base. That made the baked fable variant
 * inert on exactly the machines that have CC installed (verified live:
 * CC_SYSTEM_PROMPT_FABLE === CC_SYSTEM_PROMPT with a fresh cache present).
 * Variants the live template already has win, so a future per-model live
 * capture supersedes the bake without another change here.
 *
 * `tools` was the same bug one field over, and it outranks the variants one:
 * the cache on the audit machine held 24 tools against the bundle's 34, and
 * the missing ten were EXACTLY the three preservation sets, no remainder.
 * Because cc-template.ts derives CC_NATIVE_NAMES_UNION from whatever
 * loadTemplate returns, a client that declares one of the dropped tools stops
 * identity-mapping and falls into the unmapped round-robin with junk args —
 * the v4.8.93 regression, which the bake defends against and the runtime did
 * not. Measured: the shared 24 were byte-identical and in the same order, so
 * the live cache contributed nothing here and cost ten tools.
 */
export function withBundledFallbacks(live: TemplateData, preloaded?: TemplateData): TemplateData {
  let bundled: TemplateData;
  if (preloaded) {
    bundled = preloaded;
  } else {
    try {
      bundled = loadBundledTemplate({ silent: true });
    } catch {
      return live; // bundle unreadable — better the base prompt than a throw
    }
  }

  const out: TemplateData = { ...live };

  const liveVariants = promptVariantsOf(live);
  const merged = { ...promptVariantsOf(bundled), ...liveVariants };
  if (Object.keys(merged).length > 0) out.system_prompt_variants = merged;

  const tools = unionToolsOnBundleOrder(live.tools, bundled.tools);
  if (tools) {
    out.tools = tools;
    // `tool_names` is a parallel array that every builder DERIVES rather than
    // maintains (scrub-template.ts, capture-and-bake.mjs). Updating `tools`
    // and leaving it is the documented divergence class — the shipped bundle
    // once carried tool_names 30 against tools 33, and a consumer trusting
    // tool_names as the inventory reads a different template than one reading
    // tools.
    out.tool_names = tools.map((tool) => tool.name);
  }

  // Attribution, for the banner. Computed here because this is the only place
  // that holds both sides; see `_fromBundle`.
  const liveToolNames = new Set((Array.isArray(live.tools) ? live.tools : []).map((t) => t.name));
  out._fromBundle = {
    tools: (out.tools ?? []).map((t) => t.name).filter((n) => !liveToolNames.has(n)),
    variants: Object.keys(merged).filter((k) => liveVariants[k] === undefined).sort(),
  };
  return out;
}

/** Once per process: the banner already reports the outcome on every start. */
let warnedRegression = false;

/**
 * Why a live template must not be used, or null when it is fit to serve.
 *
 * Compared against the bundle, because the bundle is the only reference the
 * running proxy has for what a healthy template looks like. What this does
 * NOT do is reject a capture for carrying fewer tools than the bundle: a
 * `claude --print` capture is narrower by construction — measured on CC
 * 2.1.236, twelve of the bundle's thirty-four, missing Glob, Grep, the Web*
 * pair, AskUserQuestion and the whole Task/Cron families, because none of
 * them mean anything without a UI. Rejecting on tool count would reject every
 * capture on every machine and throw away the prompt, which is the part only a
 * capture can supply. `unionToolsOnBundleOrder` repairs that axis; this one
 * guards the axes nothing can repair.
 *
 * The prompt is checked structurally rather than by size. The failure worth
 * catching is `pickTextBlock(systemBlocks[2])` returning something that is not
 * the prompt — the billing tag or the identity, after CC reshuffles its system
 * blocks — and the invariant that separates those cases is that CC's prompt is
 * always longer than its identity block, by three orders of magnitude on every
 * capture measured (62 bytes against 4802 to 27594).
 *
 * A size floor relative to the bundle was the first attempt and it was wrong.
 * The legitimate spread across model families is 5.7x on this bundle alone, so
 * any ratio tight enough to add something over the structural rule sits inside
 * the range of correct prompts. What it did catch, immediately, was three
 * suites' synthetic templates — which is not proof it would misfire in
 * production, but it does mean the rule was keying on size where nothing else
 * in the system does, to catch a collapsed-but-still-larger-than-the-identity
 * prompt that has never been observed.
 */
export function templateRegression(live: TemplateData, bundled: TemplateData): string | null {
  const prompt = typeof live.system_prompt === 'string' ? live.system_prompt : '';
  const identity = typeof live.agent_identity === 'string' ? live.agent_identity : '';
  if (prompt.length === 0) return 'the system prompt is empty';
  if (identity.length === 0) return 'the agent identity block is empty';
  // The 3-block layout shifting by one puts the identity where the prompt
  // belongs. Both fields stay non-empty, so every other check passes.
  if (prompt === identity) {
    return 'the system prompt and the agent identity are the same string, so the captured '
      + 'system blocks are not in the layout extractTemplate assumes';
  }
  // Same defect, the cases where the two blocks are not byte-equal: block [2]
  // holding the billing tag, or a truncated read. CC's prompt is never shorter
  // than its identity line.
  if (prompt.length <= identity.length) {
    return `the system prompt is ${prompt.length} bytes against a ${identity.length}-byte `
      + 'identity block, so the captured system blocks are not in the layout '
      + 'extractTemplate assumes';
  }
  // Not a count test — an identity test. A capture sharing no tool with the
  // bundle is not a narrower CC, it is not CC: a wrapper binary, a different
  // product, or a `claude` on PATH that belongs to something else.
  const bundledNames = new Set((Array.isArray(bundled.tools) ? bundled.tools : []).map((t) => t.name));
  const liveTools = Array.isArray(live.tools) ? live.tools : [];
  if (bundledNames.size > 0 && liveTools.length > 0 && !liveTools.some((t) => bundledNames.has(t.name))) {
    return `none of the ${liveTools.length} captured tools appear in the bundle, so the capture `
      + 'did not come from a CC this dario knows';
  }
  return null;
}

/**
 * Where the live fingerprint cache lives. Resolved per call and overridable
 * with DARIO_LIVE_TEMPLATE_CACHE.
 *
 * The override exists because test/live-fingerprint.mjs writes FAKE templates
 * here to exercise loadTemplate's accept/reject rules, and it was writing to the
 * REAL path. Two consequences, one intermittent and one dangerous:
 *
 *  1. Under --test-concurrency=8 the other suites are concurrent PROCESSES, and
 *     any that imports cc-template.js reads this file at module init. So
 *     issue-29-tool-translation.mjs intermittently initialised against a 1-tool
 *     fake and failed ~1 run in 5. Reproduced deterministically: 54 pass / 0 fail
 *     with no cache, 48 pass / 6 fail with the fake on disk.
 *  2. The test backs up and restores on exit, so a crash between its write and
 *     its restore leaves the operator's own dario serving
 *     'FAKE LIVE SYSTEM PROMPT' until someone deletes the file by hand.
 *
 * Resolved per call, NOT captured in a module-level const: ESM imports are
 * hoisted, so a test setting the env var in its body would run after a const had
 * already read the real path.
 */
function liveCachePath(): string {
  const override = process.env['DARIO_LIVE_TEMPLATE_CACHE'];
  return override && override.length > 0
    ? override
    : join(homeDir(), '.dario', 'cc-template.live.json');
}
const LIVE_TTL_MS = 24 * 60 * 60 * 1000; // re-extract once a day

/**
 * Load the template synchronously. Prefers the live cache (fresh capture
 * from the user's own CC install) and falls back to the bundled snapshot.
 *
 * This is intentionally sync and fast — it runs at module init on every
 * dario request handler. The actual capture is async and runs in the
 * background via refreshLiveFingerprintAsync(); its results are written
 * to the cache file and picked up on the next dario startup.
 */
export function loadTemplate(_options?: { silent?: boolean }): TemplateData {
  const cached = readLiveCache();
  if (cached) {
    const bundled = loadBundledTemplate(_options);
    // A live template the bundle beats outright is not merged, it is dropped.
    // The merge repairs `tools` and `system_prompt_variants`; nothing repairs
    // `system_prompt`, so a degenerate one is served for the cache's whole TTL
    // and there is no route back to the bundle short of deleting the file by
    // hand. The write path refuses to create one; this refuses to serve one
    // that is already on disk, written by an older dario or by hand.
    const regression = templateRegression(cached, bundled);
    if (regression) {
      if (!warnedRegression) {
        warnedRegression = true;
        console.error(
          `[dario] ⚠  live template ignored: ${regression}. Serving the bundled snapshot; `
          + 'the next background refresh will re-capture.',
        );
      }
      return bundled;
    }
    const age = Date.now() - new Date(cached._captured).getTime();
    if (age < LIVE_TTL_MS) {
      return withBundledFallbacks(cached, bundled);
    }
    // Stale cache: prefer whichever of the live cache and the bundled
    // snapshot was captured more recently — do NOT blindly keep the cache.
    // A frozen live cache must not shadow a newer bundled template, which is
    // exactly what happens in a no-CC deployment (e.g. the Hetzner container):
    // the async refresh can never run there, so the cache stays pinned at its
    // last capture while shipped releases move the bundle ahead. Without this
    // comparison, every bundled-template update is silently ignored until the
    // cache file is removed by hand. A fresh live capture (age < TTL) still
    // wins above; a stale cache only wins if it is still newer than the bundle.
    const cachedAt = new Date(cached._captured).getTime();
    const bundledAt = new Date(bundled._captured).getTime();
    return Number.isFinite(bundledAt) && bundledAt > cachedAt ? bundled : withBundledFallbacks(cached, bundled);
  }
  return loadBundledTemplate(_options);
}

/**
 * Kick off a background live fingerprint capture. Safe to call on every
 * dario proxy startup — no-ops if CC isn't installed, if the cache is
 * already fresh, or if another refresh is in flight. Never throws.
 *
 * Result is written to ~/.dario/cc-template.live.json and picked up on
 * the next dario startup (cc-template.ts loads the cache synchronously
 * at module init).
 */
export async function refreshLiveFingerprintAsync(options?: {
  force?: boolean;
  silent?: boolean;
  timeoutMs?: number;
}): Promise<TemplateData | null> {
  const silent = options?.silent ?? false;
  const log = (msg: string) => { if (!silent) console.log(`[dario] ${msg}`); };

  if (!options?.force) {
    const cached = readLiveCache();
    if (cached) {
      const age = Date.now() - new Date(cached._captured).getTime();
      if (age < LIVE_TTL_MS) return cached;
    }
  }

  if (!findClaudeBinary()) return null;

  try {
    const timeoutMs = options?.timeoutMs ?? 10_000;
    const live = await captureLiveTemplateAsync(timeoutMs);
    if (!live) {
      log('live fingerprint refresh: capture returned null (CC did not send a /v1/messages request within the timeout)');
      return null;
    }
    // Gate BEFORE the variant sweep, not after: the sweep is four more
    // captures, and there is no point paying for them to decorate a template
    // that is about to be thrown away.
    try {
      const regression = templateRegression(live, loadBundledTemplate({ silent: true }));
      if (regression) {
        log(`live fingerprint refresh: capture rejected — ${regression}. Keeping the bundled template.`);
        return null;
      }
    } catch {
      // Bundle unreadable — nothing to compare against. Writing an unchecked
      // capture is still better than serving a bundle we cannot even load.
    }
    const variants = await captureVariantPromptsAsync(live.system_prompt, timeoutMs, log);
    if (Object.keys(variants).length > 0) {
      live.system_prompt_variants = { ...(live.system_prompt_variants ?? {}), ...variants };
    }
    writeLiveCache(live);
    log(`live fingerprint refreshed from CC ${live._version}`);
    return live;
  } catch (err) {
    log(`live fingerprint refresh failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Capture each family in VARIANT_FAMILIES under its own model.
 *
 * The runtime refresh used to capture once, on the base model, and write a
 * cache with no `system_prompt_variants` at all. `withBundledFallbacks` then
 * filled the gap from the bundle — which is the right failure mode but not a
 * mirror: the bundle's variants are SCRUBBED, so they carry no `# Environment`
 * section, and they are as old as the last bake. Every model-specific line
 * that could only come from a capture under that model — the knowledge cutoff
 * above all, opus-5's real answer being May 2026 where the base says January —
 * was unavailable, and the request path could only drop it.
 *
 * Costs one `claude --print` per family against the loopback MITM, which bills
 * nothing: the sandbox never reaches Anthropic. It runs in the background
 * refresh, not on any request path.
 *
 * A family is stored only when its prompt DIFFERS from the base, mirroring
 * `capture-and-bake.mjs` — an identical capture is a measured "no variant",
 * and writing it would bloat the cache and hide the shared-prompt fact. A
 * family whose capture fails is simply absent, so `withBundledFallbacks`
 * supplies the bundle's as before.
 */
async function captureVariantPromptsAsync(
  base: string,
  timeoutMs: number,
  log: (msg: string) => void,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const failed: string[] = [];
  const sharedBase: string[] = [];
  for (const family of VARIANT_FAMILIES) {
    let captured: TemplateData | null = null;
    try {
      captured = await captureLiveTemplateAsync(timeoutMs, family.captureModel);
    } catch {
      captured = null;
    }
    if (!captured || typeof captured.system_prompt !== 'string' || captured.system_prompt.length === 0) {
      failed.push(family.key);
      continue;
    }
    if (captured.system_prompt === base) {
      sharedBase.push(family.key);
      continue;
    }
    out[family.key] = captured.system_prompt;
  }
  const parts: string[] = [];
  if (Object.keys(out).length > 0) parts.push(`captured ${Object.keys(out).join(', ')}`);
  if (sharedBase.length > 0) parts.push(`${sharedBase.join(', ')} match the base`);
  if (failed.length > 0) parts.push(`${failed.join(', ')} failed — keeping the bundle's`);
  if (parts.length > 0) log(`live prompt variants: ${parts.join('; ')}`);
  return out;
}

function loadBundledTemplate(options?: { silent?: boolean }): TemplateData {
  const data: TemplateData = JSON.parse(
    readFileSync(join(__dirname, 'cc-template-data.json'), 'utf-8'),
  );
  data._source = 'bundled';

  // Bundled-snapshot-level drift warning. If the user's installed CC is
  // newer than the version the bundled snapshot was verified against, the
  // proxy will still run — but the operator should know they're on a shape
  // that wasn't tested against their CC. The --strict-template / -no-live-
  // capture flags (dario#77) are the fail-closed knobs; this is the soft
  // warn that precedes them. dario#76.
  if (!options?.silent && data._supportedMaxTested) {
    try {
      const installedCCVersion = probeInstalledCCVersion();
      if (installedCCVersion && compareVersions(installedCCVersion, data._supportedMaxTested) > 0) {
        console.log(
          `[dario] ⚠  bundled template was last verified against CC v${data._supportedMaxTested} but installed CC is v${installedCCVersion}. ` +
          `Background refresh will attempt a live capture; if that fails, fingerprint-sensitive fields may be stale.`
        );
      }
    } catch {
      // probeInstalledCCVersion can throw in sandboxed environments; the
      // bundled template is still valid, so swallow and continue.
    }
  }

  return data;
}

function readLiveCache(): TemplateData | null {
  const cachePath = liveCachePath();
  if (!existsSync(cachePath)) return null;
  let raw: string;
  try {
    raw = readFileSync(cachePath, 'utf-8');
  } catch {
    return null;
  }

  let parsed: TemplateData;
  try {
    parsed = JSON.parse(raw) as TemplateData;
  } catch (err) {
    // Unparseable JSON — typically a crash or power-loss mid-write on a
    // pre-v3.17 dario that still used a non-atomic writer. Quarantine
    // the bad file so the next refresh can write a clean one, and log
    // loudly so the user doesn't silently sit on a broken cache forever.
    quarantineCorruptCache(`unparseable JSON (${(err as Error).message})`);
    return null;
  }

  if (!parsed || !parsed.system_prompt || !Array.isArray(parsed.tools) || parsed.tools.length === 0) {
    quarantineCorruptCache('missing required fields (system_prompt / tools)');
    return null;
  }

  // Pre-4.8.145 captures baked the operator's mcp__* tools into the template
  // (dario#678 regression: duplicate tool names → upstream 400). The capture
  // path filters them now, but a polluted cache written by an older dario
  // sits on disk until something rewrites it — its junk union and inflated
  // doctor Overhead numbers persist (the #678 reporter's cache showed 138
  // tool defs, ~111 of them MCP). Quarantine on load; the background refresh
  // re-captures clean.
  if ((parsed.tools as Array<{ name?: unknown }>).some((t) => typeof t?.name === 'string' && t.name.startsWith('mcp__'))) {
    quarantineCorruptCache('mcp__ tool pollution (pre-4.8.145 capture)');
    return null;
  }

  // Schema version mismatch is NOT corruption — it's an expected event on
  // dario upgrade or downgrade. Skip the cache silently; the background
  // refresh will rewrite it in the new shape.
  if (parsed._schemaVersion !== CURRENT_SCHEMA_VERSION) return null;

  parsed._source = 'live';
  return parsed;
}

/**
 * Rename a corrupt cache file aside to `.corrupt-<ISO>` so the next
 * refresh writes a fresh cache without first having to overwrite a bad
 * file. Keeping the original as-is would also work, but quarantining
 * makes it clearer in `ls ~/.dario` that the file was rejected, and
 * preserves the contents for post-mortem in case a user files an issue.
 */
function quarantineCorruptCache(reason: string): void {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const aside = `${liveCachePath()}.corrupt-${stamp}`;
    renameSync(liveCachePath(), aside);
    console.error(`[dario] ⚠  live template cache rejected: ${reason}. Quarantined to ${aside}. Next background refresh will re-capture.`);
  } catch (err) {
    // If the rename itself fails, leave the file in place — a subsequent
    // refresh will overwrite it atomically. Log so the state is visible.
    console.error(`[dario] ⚠  live template cache rejected: ${reason}. (quarantine rename failed: ${(err as Error).message})`);
  }
}

/**
 * Atomic JSON write: dump to a sibling `.tmp` file, then rename over the
 * target path. A crash or Ctrl+C between writes never leaves a half-
 * written file where `JSON.parse` would throw on next read. Uses a pid-
 * qualified tmp name so concurrent dario processes don't stomp on each
 * other's partial writes. Exposed for tests via `_atomicWriteJsonForTest`.
 */
function atomicWriteJson(targetPath: string, data: unknown): void {
  // 0700: whichever code path creates ~/.dario first decides that directory's
  // permissions, and this one runs at startup, before any credential write.
  // Without a mode it lands 755 on Linux, which makes every non-0600 file inside
  // world-readable. The credential paths already create their dirs 0700; this was
  // the one that could get there first and did not.
  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
  const tmp = `${targetPath}.${process.pid}.tmp`;
  try {
    // 0600: this file holds the UNSCRUBBED live capture. Verified on the Linux
    // deployment to contain `# Environment` (cwd, OS, platform) and `gitStatus:`
    // (branch, modified files, recent commits); structurally it can also carry
    // `# claudeMd`, `# userEmail` and `# auto memory` — the scrub list exists
    // because CC emits them. Credentials beside it are 0600; this was 0644.
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, targetPath);
  } catch (err) {
    // Clean up the stray tmp if the rename failed; swallow its own
    // unlink error — nothing useful to do with it.
    try { unlinkSync(tmp); } catch { /* noop */ }
    throw err;
  }
}

/** Test-only surface for `atomicWriteJson`. Production code uses `writeLiveCache`. */
export function _atomicWriteJsonForTest(targetPath: string, data: unknown): void {
  atomicWriteJson(targetPath, data);
}

function writeLiveCache(data: TemplateData): void {
  atomicWriteJson(liveCachePath(), data);
}

interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  /**
   * The flat [k1, v1, k2, v2, ...] array exactly as Node exposes it via
   * req.rawHeaders. Preserves insertion order and duplicates, which the
   * flattened `headers` map does not. Used to recover CC's header order.
   */
  rawHeaders: string[];
  body: Record<string, unknown>;
}

/**
 * Does this request belong to the capture we started?
 *
 * The MITM used to accept the FIRST request whose URL contained
 * `/v1/messages` with nothing tying it to the child we spawned (dario#872).
 * The port is ephemeral, so a collision is improbable rather than
 * impossible, and nothing downstream could tell a foreign request from the
 * child's once it was captured.
 *
 * The nonce rides in the URL path because that is the one channel we fully
 * control without touching what CC sends. Two measurements decided it over a
 * key-borne nonce:
 *
 *   1. CC honours a path segment in ANTHROPIC_BASE_URL — given
 *      `http://127.0.0.1:PORT/<nonce>` it requests
 *      `/<nonce>/v1/messages?beta=true` (and probes `/<nonce>/api/hello`
 *      first, which still 404s here).
 *   2. On a subscription install CC authenticates with
 *      `authorization: Bearer sk-ant-…`, so ANTHROPIC_API_KEY is not the auth
 *      header at all. A key-borne nonce would do nothing on OAuth installs
 *      while changing the auth path for API-key ones — and changing what the
 *      child authenticates with can change what it sends, which is the whole
 *      thing a fingerprint capture must not do.
 *
 * Fails closed: no nonce, no capture. A miss makes the capture return null
 * and the bake exit non-zero, which is the correct outcome for a request we
 * cannot attribute.
 */
export function isOwnCaptureRequest(url: string | undefined, nonce: string): boolean {
  if (!url || nonce.length === 0) return false;
  if (!url.startsWith(`/${nonce}/`)) return false;
  return url.includes('/v1/messages');
}

/**
 * Run a loopback MITM server on a random port, spawn CC with
 * ANTHROPIC_BASE_URL pointed at it, wait for one request, respond with a
 * minimal valid SSE stream, and return the captured request.
 *
 * `model` pins what CC is asked to serve, which decides which system prompt
 * it composes. Omitted, the capture falls back to ANTHROPIC_MODEL and then to
 * TEMPLATE_BASE_MODEL, so an unpinned call still captures the shared base.
 *
 * Returns null on timeout or spawn failure. Does not throw.
 */
export async function captureLiveTemplateAsync(
  timeoutMs: number = 10_000,
  model?: string,
): Promise<TemplateData | null> {
  const captured = await runCapture(timeoutMs, model);
  if (!captured) return null;
  return extractTemplate(captured);
}

/**
 * The environment the capture child is allowed to see.
 *
 * This used to be `{...process.env}` with four `delete`s on top. A denylist
 * cannot work here: CC reads more redirect variables than any list we write
 * will name, and each one has the same silent symptom — the child goes
 * somewhere other than the MITM, bills the operator, and capture reports the
 * indistinguishable "no request arrived". Measured against the installed
 * 2.1.235 binary, everything below reached a real spawned child on top of the
 * four that were deleted: five more `CLAUDE_CODE_USE_*` platform switches,
 * their matching `ANTHROPIC_*_BASE_URL` pairs, `ANTHROPIC_API_HOST`,
 * `ANTHROPIC_UNIX_SOCKET` (which bypasses the base URL entirely),
 * `ANTHROPIC_CUSTOM_HEADERS` (which also pollutes the captured header order),
 * `CLAUDE_ENV_FILE` (CC reads that file and applies it as the session
 * environment, so it re-opens the original bug verbatim), and all six proxy
 * variables — the MITM is plain `http://127.0.0.1:PORT`, so on a host with
 * `HTTP_PROXY` set and no loopback entry in `NO_PROXY` the capture request is
 * handed to that proxy, a population that overlaps heavily with the router
 * operators this sandbox exists for.
 *
 * So the child gets an allowlist: enough to find and run a binary, and
 * nothing that can decide where its request goes. Verified by capture, not by
 * reading — a child spawned with exactly this set produced a system prompt
 * byte-identical to one spawned with the full 104-variable inherited
 * environment, on every family in VARIANT_FAMILIES.
 *
 * The tradeoff is a real one: a host that needs an inherited variable to run
 * CC at all (a wrapper script reading something exotic) now fails to capture
 * and serves the bundled template. That is the safe direction — the bundle is
 * always correct-ish, and a hijacked capture is silently wrong forever.
 */
const CAPTURE_ENV_ALLOW_POSIX: readonly string[] = [
  'PATH',      // find the binary, and the `git`/`rg` CC shells out to
  'HOME',      // not needed by the capture itself (measured), but a wrapper
               // script or version manager may resolve itself against it
  'SHELL', 'USER', 'LOGNAME',
  'TMPDIR',
  'LANG', 'LANGUAGE', 'TZ', 'TERM',   // plus LC_*, by prefix
];

/**
 * Windows equivalents. Node's `process.env` is case-insensitive on win32 but
 * the object's keys keep their original case, so the match is folded.
 */
const CAPTURE_ENV_ALLOW_WIN32: readonly string[] = [
  'PATH', 'PATHEXT', 'ComSpec',
  'SystemRoot', 'SystemDrive', 'windir',
  'TEMP', 'TMP',
  'USERPROFILE', 'USERNAME', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'COMPUTERNAME', 'TZ',
];

/**
 * Build the capture child's environment: `base` filtered to the allowlist,
 * then `pinned` applied on top so nothing inherited can shadow the sandbox.
 *
 * Exported for the isolation suite, which asserts the behaviour — feed it a
 * poisoned environment and check what survives — rather than the spelling of
 * a `delete` line. Nine of these were added by reading the binary; the tenth
 * kind is the one nobody has enumerated yet, and only an allowlist covers it.
 */
export function captureChildEnv(
  base: NodeJS.ProcessEnv,
  pinned: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const win = platform === 'win32';
  const allow = new Set(
    (win ? CAPTURE_ENV_ALLOW_WIN32 : CAPTURE_ENV_ALLOW_POSIX).map((k) => (win ? k.toLowerCase() : k)),
  );
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value !== 'string') continue;
    if (allow.has(win ? key.toLowerCase() : key) || (!win && key.startsWith('LC_'))) out[key] = value;
  }
  return { ...out, ...pinned };
}

/**
 * Environment keys a managed policy file can set to move the capture child.
 *
 * The same names the allowlist keeps out of the child's inherited
 * environment — a policy `env` block reaches CC by a route the allowlist
 * cannot touch, so the two defences need the same list. Read out of the
 * 2.1.235 binary; `ANTHROPIC_CUSTOM_HEADERS` is here because it can carry
 * auth to whichever endpoint wins as well as pollute the captured header
 * order.
 */
const MANAGED_HIJACK_ENV_KEYS: readonly string[] = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_HOST', 'ANTHROPIC_UNIX_SOCKET',
  'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_AWS_BASE_URL', 'ANTHROPIC_GOOGLE_CLOUD_BASE_URL', 'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GATEWAY', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_ENV_FILE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy',
  'CLAUDE_CODE_HTTP_PROXY', 'CLAUDE_CODE_HTTPS_PROXY',
];

/** Top-level policy keys with the same effect, by a route `env` cannot show. */
const MANAGED_HIJACK_SETTINGS_KEYS: readonly string[] = [
  'apiKeyHelper', 'awsAuthRefresh', 'gcpAuthRefresh', 'forceLoginMethod', 'primaryApiKey',
  'model',
];

/**
 * Enterprise managed settings that would defeat the capture sandbox.
 *
 * `CLAUDE_CONFIG_DIR` relocates the user's config, which is what stops a
 * personal `settings.json` hijacking the capture. It deliberately does NOT
 * relocate the machine-level policy file — the whole point of a managed
 * setting is that a user cannot opt out of it — and a managed `env` block
 * outranks everything else. So on a managed host the capture would be
 * redirected upstream and billed, with the same silent `capture returned
 * null` we can no longer distinguish it by.
 *
 * We cannot neutralize the policy file. We can decline to spend the
 * operator's subscription discovering it, and say why.
 *
 * Paths and precedence read out of the CC 2.1.235 binary, not inferred:
 * the base dir is a hardcoded switch (`/Library/Application Support/ClaudeCode`,
 * `C:\Program Files\ClaudeCode`, else `/etc/claude-code`) with no env or CLI
 * override, plus a `managed-settings.d` drop-in dir beside it. Note it is
 * Program Files, NOT ProgramData — that string appears nowhere in the binary,
 * and a bail pointed at it would silently never fire on Windows.
 *
 * This is best-effort by nature and cannot be completed by adding paths: under
 * WSL with `wslInheritsWindowsSettings`, CC also reads the Windows policy
 * chain including an HKLM registry key, which is not a file at all. The
 * post-spawn check in `runCapture` is the sound backstop; this one just makes
 * the common cases cheap and legible.
 *
 * `paths` is injectable so this is testable without writing to a real
 * machine-level policy path.
 *
 * The check used to look at `env.ANTHROPIC_BASE_URL` and nothing else, which
 * made it the narrowest of the three defences: exercised against the real
 * function with injected policy files, it proceeded on all seventeen other
 * ways a policy file can move the child. `CLAUDE_CODE_USE_BEDROCK` and
 * `_VERTEX` were the sharpest — the spawn deleted both from the inherited
 * environment because it knew they were billing routes, and named them in its
 * own warning text, while this guard ignored them. `apiKeyHelper` matters
 * more than it looks: the binary maps it to `["ANTHROPIC_BASE_URL",
 * "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL"]`, so it sets the very variable
 * the guard checked, by a route the guard could not see.
 *
 * `model` is in the list for a different reason. It does not bill anything;
 * it overrides the `ANTHROPIC_MODEL` pin, so every family in the variant
 * sweep would capture the same wrong prompt and dario would serve it to the
 * others. A capture that is silently the wrong model is worse than no
 * capture, because the bundle is at least right about which model it is.
 */
export function managedSettingsHijack(paths?: string[]): { path: string; key: string } | null {
  const baseDir = process.platform === 'darwin'
    ? '/Library/Application Support/ClaudeCode'
    : process.platform === 'win32'
      ? 'C:\\Program Files\\ClaudeCode'
      : '/etc/claude-code';
  let candidates: string[];
  if (paths) {
    candidates = paths;
  } else {
    candidates = [join(baseDir, 'managed-settings.json')];
    // Drop-in dirs are the standard shape for config-management-deployed
    // policy, so this is the likelier real-world layout of the two.
    try {
      const dropIn = join(baseDir, 'managed-settings.d');
      for (const name of readdirSync(dropIn).sort()) {
        if (name.endsWith('.json')) candidates.push(join(dropIn, name));
      }
    } catch { /* absent or unreadable — nothing to add */ }
  }
  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue;
      const settings = JSON.parse(readFileSync(path, 'utf-8')) as {
        env?: Record<string, unknown>;
      } & Record<string, unknown>;
      const set = (v: unknown): boolean =>
        (typeof v === 'string' && v.length > 0) || v === true || typeof v === 'number';
      for (const key of MANAGED_HIJACK_ENV_KEYS) {
        if (set(settings?.env?.[key])) return { path, key: `env.${key}` };
      }
      for (const key of MANAGED_HIJACK_SETTINGS_KEYS) {
        if (set(settings?.[key])) return { path, key };
      }
    } catch { /* unreadable or malformed — not ours to diagnose */ }
  }
  return null;
}

/**
 * Capture dirs that exist right now, swept if the process exits before their
 * own sweep runs.
 *
 * `settle` arms cleanup on the child's `exit` event with an unref'd 30s
 * backstop. Both are cancelled by the parent exiting: the event is never
 * delivered, and the backstop is unref'd precisely so it cannot hold the
 * process open. So every dario invocation shorter than its own capture leaked
 * one dir — `doctor`, `--version`, any CLI command that arms the background
 * refresh and returns in milliseconds, plus every test that starts a proxy
 * without `noLiveCapture`. Each dir holds a ~32KB .claude.json and a session
 * transcript.
 *
 * Registered at mkdtemp rather than inside `settle`, which is what makes this
 * cover the whole window: a parent that exits before `settle` ever runs would
 * otherwise strand the dir with no handler armed at all.
 *
 * rmSync is synchronous, so it is legal in an exit handler — an async unlink
 * would not be.
 */
const PENDING_CAPTURE_HOMES = new Set<string>();
let captureExitHookArmed = false;

function trackCaptureHome(home: string): void {
  PENDING_CAPTURE_HOMES.add(home);
  if (captureExitHookArmed) return;
  captureExitHookArmed = true;
  process.on('exit', () => {
    for (const dir of PENDING_CAPTURE_HOMES) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
    }
    PENDING_CAPTURE_HOMES.clear();
  });
}

function releaseCaptureHome(home: string): void {
  PENDING_CAPTURE_HOMES.delete(home);
}

/**
 * Make the capture sandbox a git repository, so CC composes the `gitStatus:`
 * block it appends to every prompt it sends from inside a working tree.
 *
 * Without this the sandbox is a bare `/tmp` directory, CC reports
 * `Is a git repository: false` and appends nothing — measured, and the reason
 * `environment-block.ts` had no captured gitStatus shape to rewrite. The block
 * cannot be written from scratch under this codebase's rewrite-never-invent
 * rule; it has to come from CC. So the sandbox is given the smallest repo that
 * makes CC emit one, and the request path substitutes the serving host's own
 * branch, user, status and commits into that captured shape.
 *
 * The repo is seeded CLEAN and committed, which is deliberate: CC renders a
 * clean tree as the literal `(clean)`, and that literal is what the rewrite
 * falls back to when the serving repo has nothing modified. A sandbox left
 * dirty would put its own junk where that word belongs.
 *
 * Fully isolated from the operator's git configuration — a global
 * `init.templateDir`, a `core.hooksPath`, or a signing key would otherwise run
 * their own code inside the capture. Best-effort throughout: no git, a git too
 * old for `-b`, a failed commit all leave a plain directory behind, which is
 * exactly the pre-existing behaviour.
 */
function seedCaptureRepo(home: string): void {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', home, ...args], {
      env,
      stdio: 'ignore',
      timeout: 5_000,
    });
  };
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'dario');
    git('config', 'user.email', 'capture@dario.invalid');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.hooksPath', join(home, '.git', 'no-hooks'));
    writeFileSync(join(home, 'README.md'), 'dario fingerprint capture sandbox\n');
    git('add', 'README.md');
    git('commit', '-q', '-m', 'capture sandbox');
  } catch {
    // No git, or a git that refused one of these. The capture still runs; it
    // just produces the same no-gitStatus prompt it produced before.
  }
}

/** Test-only surface for `seedCaptureRepo`. Production code calls it from `runCapture`. */
export function _seedCaptureRepoForTest(home: string): void {
  seedCaptureRepo(home);
}

async function runCapture(timeoutMs: number, model?: string): Promise<CapturedRequest | null> {
  const managed = managedSettingsHijack();
  if (managed) {
    console.log(
      `[dario] live capture skipped: ${managed.path} sets ${managed.key}, which outranks `
      + 'the capture sandbox — the probe would be billed upstream, or would record the wrong '
      + 'model. Serving the bundled template.',
    );
    return null;
  }
  const nonce = `dario-capture-${randomBytes(12).toString('hex')}`;
  return new Promise((resolve) => {
    let captured: CapturedRequest | null = null;
    let settled = false;
    let foreign = 0;
    const settle = (result: CapturedRequest | null) => {
      if (settled) return;
      settled = true;
      try { server.close(); } catch { /* noop */ }
      // Positive assertion, and the only check that is sound across every
      // override channel. A path-scanning guard cannot be completed — settings
      // can be overridden from the user config, a project `.claude/`, a managed
      // policy file, a drop-in dir, or (under WSL) an HKLM registry key that is
      // not a file at all. But whatever won, exactly one thing is true
      // afterwards: either the nonce'd request arrived here, or it went
      // somewhere else and was probably billed.
      //
      // Distinguishing that from "no CC installed" is the whole lesson of this
      // bug: for a month both reported the same "capture returned null", so a
      // billed-and-failing probe was indistinguishable from a no-op.
      if (result === null && childSpawned && foreign === 0) {
        console.error(
          '[dario] live capture: CC ran but its request never reached the capture endpoint. '
          + 'Either it went upstream instead — in which case it was BILLED to your subscription — '
          + 'or it exited without sending one. If this repeats, something is overriding '
          + 'ANTHROPIC_BASE_URL for the child: a settings.json `env` block (user, project, or '
          + 'managed policy), or CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX. '
          + 'Set DARIO_NO_LIVE_CAPTURE=1 to stop capturing until it is resolved.',
        );
      }
      // The throwaway config dir is CC's HOME for this spawn, so CC writes a
      // session transcript and config into it. Removing it keeps capture from
      // littering the operator's real ~/.claude/projects with one junk
      // `hi` session per proxy start.
      //
      // Do not race the child for it. SIGTERM is not synchronous and CC keeps
      // rebuilding its config skeleton for tens of seconds after being asked to
      // stop — measured at ~20s, which left three stale dirs per proxy start
      // behind a sweep that fired at 2s. The capture is a throwaway probe with
      // nothing to flush, so SIGKILL it (which it cannot ignore, so it cannot
      // write again) and sweep once it is actually gone.
      const home = captureHome;
      const sweep = () => {
        if (!home) return;
        try { rmSync(home, { recursive: true, force: true }); } catch { /* noop */ }
        // Drop it from the exit-hook set so a long-lived proxy does not
        // accumulate one dead path per capture for the life of the process.
        releaseCaptureHome(home);
      };
      if (child && child.exitCode === null && child.signalCode === null) {
        child.once('exit', sweep);
        // Backstop for a child that never reports exit at all. unref'd so a
        // pending sweep can never hold the proxy open on shutdown.
        const backstop = setTimeout(sweep, 30_000);
        if (typeof backstop.unref === 'function') backstop.unref();
        try { child.kill('SIGKILL'); } catch { /* noop */ }
      } else {
        // The child is already gone, or was never spawned. Reached whenever
        // `settle` runs after the child has exited, which the old code had no
        // sweep for at all: the `exitCode === null` guard was false, `once`
        // was never armed, `kill` was a no-op on a corpse, and the `if (!child)`
        // fallback was false because the child object still existed.
        //
        // Guaranteed on the failed-capture path — a child that exits without
        // sending settles from its own `exit` handler 200ms later — and that
        // is the path that repeats, once per proxy start, for as long as
        // capture stays broken. It is also racy on the SUCCESS path: the
        // request-arrived settle is on a 500ms timer and the child-exited one
        // on a 200ms timer, so a CC that exits promptly after sending settles
        // through here too. Measured at 19 stranded dirs on one machine, each
        // holding a full .claude.json and a session transcript.
        //
        // Nothing can write to the dir any more, so sweep now rather than
        // arming a handler on a process that will never emit again.
        sweep();
      }
      resolve(result);
    };

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // Only handle OUR /v1/messages — everything else gets a 404 so CC
      // doesn't accidentally think /v1/models is live, and so a request we
      // cannot attribute to the spawned child is never captured (dario#872).
      if (!isOwnCaptureRequest(req.url, nonce)) {
        // A /v1/messages without our nonce is exactly the case #872 is about:
        // something else reached this port. Say so — a silent 404 here is how
        // a foreign capture would have gone unnoticed.
        if (req.url?.includes('/v1/messages')) {
          foreign++;
          console.error(
            `[dario] capture: rejected a /v1/messages request that did not carry this capture's nonce (${foreign} so far) — see dario#872`,
          );
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"type":"error","error":{"type":"not_found_error","message":"not found"}}');
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf-8');
          const body = raw ? JSON.parse(raw) : {};
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(req.headers)) {
            if (typeof v === 'string') headers[k] = v;
            else if (Array.isArray(v)) headers[k] = v.join(',');
          }
          captured = {
            method: req.method ?? 'POST',
            path: (req.url ?? '/v1/messages').replace(`/${nonce}`, ''),
            headers,
            rawHeaders: Array.isArray(req.rawHeaders) ? [...req.rawHeaders] : [],
            body,
          };
        } catch {
          // Captured body was not JSON — leave captured null, respond anyway.
        }

        // Send a minimal valid SSE stream so CC doesn't hang retrying.
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'anthropic-ratelimit-unified-representative-claim': 'five_hour',
          'anthropic-ratelimit-unified-status': 'allowed',
          'anthropic-ratelimit-unified-5h-utilization': '0',
          'anthropic-ratelimit-unified-7d-utilization': '0',
          'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 18000),
        });
        const sse = [
          `event: message_start\ndata: ${JSON.stringify({
            type: 'message_start',
            message: {
              id: 'msg_live_capture',
              type: 'message',
              role: 'assistant',
              model: 'claude-opus-4-5',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          })}\n\n`,
          `event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'ok' },
          })}\n\n`,
          `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
          `event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 1 },
          })}\n\n`,
          `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
        ].join('');
        res.end(sse);

        // Give CC a beat to read the response before we kill it.
        setTimeout(() => settle(captured), 500);
      });
    });

    server.on('error', () => settle(null));

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        settle(null);
        return;
      }
      const url = `http://127.0.0.1:${address.port}/${nonce}`;

      // Spawn CC with ANTHROPIC_BASE_URL pointed at our MITM.
      const claudeBin = findClaudeBinary();
      if (!claudeBin) {
        settle(null);
        return;
      }

      // Node 20+ won't spawn `.cmd`/`.bat` without `shell: true` (CVE-2024-27980).
      // `useShell` triggers cmd.exe on Windows — reject overrides that carry
      // shell metacharacters before the spawn, same guard as probeInstalledCCVersion.
      const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(claudeBin);
      if (useShell && /[&|><^"'%\r\n`$;(){}[\]]/.test(claudeBin)) {
        settle(null);
        return;
      }

      try {
        // Isolate CC's config for this spawn. `settings.json`'s `env` block
        // takes PRECEDENCE over the environment we hand the child, so on any
        // machine whose ~/.claude/settings.json pins ANTHROPIC_BASE_URL — the
        // normal setup behind a router proxy (cli-proxy-api, LiteLLM,
        // OpenRouter) — our ANTHROPIC_BASE_URL below was silently overridden.
        // The spawned CC then billed a REAL request against the operator's
        // subscription, the MITM timed out, and capture reported the
        // indistinguishable "CC did not send a /v1/messages request".
        // Observed in the wild at ~21.5K cached + 3.2K input tokens per proxy
        // start, with cc-template.live.json never once written.
        //
        // CLAUDE_CONFIG_DIR relocates CC's whole config root, so no
        // settings.json is found and nothing can override the sandbox. It also
        // re-arms ANTHROPIC_MODEL below, which settings' ANTHROPIC_DEFAULT_*
        // entries were overriding the same way.
        captureHome = mkdtempSync(join(tmpdir(), 'dario-capture-'));
        trackCaptureHome(captureHome);
        seedCaptureRepo(captureHome);
        // Allowlist, not `{...process.env}` minus a denylist: every variable
        // that can redirect the child is absent because it was never copied.
        // See CAPTURE_ENV_ALLOW_POSIX for what survives and why.
        const env = captureChildEnv(process.env, {
          CLAUDE_CONFIG_DIR: captureHome,
          ANTHROPIC_BASE_URL: url,
          // Always the placeholder, never the operator's real key. The MITM
          // authenticates nothing, so inheriting one bought nothing and put a
          // live credential in a child we are deliberately pointing at a
          // socket. Captures on hosts with no key set have always used this.
          ANTHROPIC_API_KEY: 'sk-dario-fingerprint-capture',
          // Pin the base-prompt model. An unpinned `claude --print` uses the
          // user's DEFAULT model, which made the captured base machine-specific.
          // The `model` argument wins, then the environment: the runtime variant
          // sweep passes the family's model directly, capture-and-bake sets
          // ANTHROPIC_MODEL around each of its own captures. Read here rather
          // than inherited, so the allowlist does not have to carry it.
          ANTHROPIC_MODEL: model ?? process.env.ANTHROPIC_MODEL ?? TEMPLATE_BASE_MODEL,
          // Belt and braces. `--print` is what actually keeps CC out of its
          // interactive UI and OAuth flow; this name appears nowhere in the
          // 2.1.235 binary, so it is inert today and costs nothing to keep.
          CLAUDE_NONINTERACTIVE: '1',
        });

        child = spawn(claudeBin, ['--print', '-p', 'hi'], {
          env,
          // Run in the throwaway dir, not wherever the proxy happens to be
          // started from. Under the systemd unit that was the operator's
          // checkout, so the captured `hi` turn dragged in that repo's
          // CLAUDE.md and git state — machine-specific noise in a template
          // that is supposed to be generic.
          cwd: captureHome,
          stdio: ['ignore', 'ignore', 'ignore'],
          windowsHide: true,
          shell: useShell,
        });
        childSpawned = true;
        // An exec failure (ENOENT, EACCES) means nothing ran and nothing was
        // billed, so retract the flag before settling or the warning misfires.
        child.on('error', () => { childSpawned = false; settle(null); });
        child.on('exit', () => {
          // Give the server a brief moment to finish reading the body in case
          // exit and request-end race.
          setTimeout(() => settle(captured), 200);
        });
      } catch {
        settle(null);
        return;
      }
    });

    let child: ReturnType<typeof spawn> | undefined;
    let captureHome: string | undefined;
    // Only true once the spawn actually succeeded. Without it, "no claude
    // binary on PATH" would trip the billed-request warning above.
    let childSpawned = false;

    // Hard timeout.
    setTimeout(() => settle(captured), timeoutMs);
  });
}

/**
 * Locate the installed `claude` binary and its version. Thin public
 * wrapper over `findClaudeBinary` + `probeInstalledCCVersion` — the
 * doctor CLI and external callers use this to report install state
 * without reaching into module-private helpers.
 */
export function findInstalledCC(): { path: string | null; version: string | null } {
  const path = findClaudeBinary();
  const version = path ? probeInstalledCCVersion() : null;
  return { path, version };
}

// Resolving the binary means enumerating candidates and, when there is more
// than one, SPAWNING each to compare versions. That is a subprocess per
// candidate per call, and there are four call sites (refresh, capture,
// findInstalledCC, drift). Profiling a proxy start showed ~720ms of blocking
// spawnSync, over half of a ~1270ms startup, from repeating this and the
// version probe. The installed binary cannot change mid-process, so resolve
// once. Keyed on the override so a test flipping DARIO_CLAUDE_BIN is not served
// a stale answer.
let _claudeBinCache: { key: string; value: string | null } | null = null;

/** Test-only: drop the resolved-binary memo. */
export function _resetClaudeBinCacheForTest(): void {
  _claudeBinCache = null;
}

function findClaudeBinary(): string | null {
  // Honor an explicit override first — useful for tests and for users on
  // non-standard installs.
  const override = process.env.DARIO_CLAUDE_BIN;
  if (override) return override;
  if (_claudeBinCache && _claudeBinCache.key === '') return _claudeBinCache.value;

  const resolved = resolveClaudeBinaryUncached();
  _claudeBinCache = { key: '', value: resolved };
  return resolved;
}

function resolveClaudeBinaryUncached(): string | null {
  const candidates = enumerateClaudeCandidates();
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // Multiple installs on PATH — common on Windows where an npm-wrapper
  // (~/AppData/Roaming/npm/claude.cmd) coexists with a native install
  // (~/.local/bin/claude.exe). Version-probe each and pick the newest.
  // Falls back to the first candidate if no probe succeeds (e.g. every
  // spawn fails on a sandboxed runtime).
  const probed: Array<{ path: string; version: string }> = [];
  for (const path of candidates) {
    const version = probeOneVersion(path);
    if (version) probed.push({ path, version });
  }
  if (probed.length === 0) return candidates[0];
  probed.sort((a, b) => compareVersions(b.version, a.version));
  return probed[0].path;
}

// Exported for unit tests.
export function enumerateClaudeCandidates(): string[] {
  const pathEnv = process.env.PATH ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const dirs = pathEnv.split(sep).filter(Boolean);
  // `.exe` first on Windows: the native binary beats a `.cmd` wrapper
  // when both live in the same dir. Across dirs we version-probe anyway
  // so order here only matters when probes all fail.
  const names = process.platform === 'win32'
    ? ['claude.exe', 'claude.cmd', 'claude']
    : ['claude'];
  const found: string[] = [];
  const seen = new Set<string>();
  for (const d of dirs) {
    for (const name of names) {
      const full = join(d, name);
      if (seen.has(full)) continue;
      try {
        if (existsSync(full)) {
          seen.add(full);
          found.push(full);
        }
      } catch { /* noop */ }
    }
  }
  return found;
}

// Version-probe one specific binary path. Same safety logic as
// probeInstalledCCVersionUncached below (reject shell metacharacters in
// override paths before spawning with shell:true on Windows).
function probeOneVersion(bin: string): string | null {
  try {
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
    if (useShell && /[&|><^"'%\r\n`$;(){}[\]]/.test(bin)) return null;
    const out = execFileSync(bin, ['--version'], {
      encoding: 'utf-8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      shell: useShell,
    });
    const m = /(\d+\.\d+\.\d+(?:[.\-][\w.\-]+)?)/.exec(out);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Given a captured /v1/messages request body, pull out the fields that
 * matter for template replay: agent identity, system prompt, tool list,
 * and CC version (from the billing header or user-agent).
 */
export function extractTemplate(captured: CapturedRequest): TemplateData | null {
  const body = captured.body;
  const systemBlocks = body.system;
  if (!Array.isArray(systemBlocks) || systemBlocks.length < 2) return null;

  // CC's system is a 3-block structure:
  //   [0] billing tag (no cache_control, tiny)
  //   [1] agent identity ("You are Claude Code..."), cache_control ephemeral (5m — no ttl field, verified CC v2.1.203)
  //   [2] system prompt (~25KB), cache_control ephemeral (5m)
  // Billing tag is per-request — we never cache it. Identity + prompt are
  // what we want.
  const agentIdentity = pickTextBlock(systemBlocks[1]);
  const systemPrompt = pickTextBlock(systemBlocks[2]);
  if (!agentIdentity || !systemPrompt) return null;

  // mcp__* tools are EXCLUDED from the template: the capture spawns the
  // operator's own CC, and on a machine with MCP servers configured the
  // captured request declares their mcp__<server>__<tool> schemas — session
  // config, not CC wire shape. Baking them poisoned CC_TOOL_DEFINITIONS_UNION
  // and duplicated any client-declared MCP tool on the advertise path
  // (template def + verbatim client schema), which upstream rejects with
  // 400 "tools: Tool names must be unique" (dario#678 follow-up). Local
  // startsWith mirror of cc-template's isMcpToolName — importing it here
  // would cycle (cc-template imports loadTemplate from this module).
  const tools = Array.isArray(body.tools)
    ? (body.tools as Array<{ name?: string; description?: string; input_schema?: Record<string, unknown> }>)
        .filter((t) => typeof t.name === 'string' && !t.name.startsWith('mcp__'))
        .map((t) => ({
          name: t.name as string,
          description: t.description ?? '',
          input_schema: t.input_schema ?? {},
        }))
    : [];
  if (tools.length === 0) return null;

  const version = extractCCVersion(captured.headers) ?? 'unknown';
  const headerOrder = extractHeaderOrder(captured.rawHeaders);
  const anthropicBeta = captured.headers['anthropic-beta'];
  const headerValues = extractStaticHeaderValues(captured.headers);
  // Top-level body key order — JSON is unordered semantically, but the
  // wire serialization has order. Captured from Object.keys on the parsed
  // body, which preserves insertion order (ES2015+).
  const bodyFieldOrder = extractBodyFieldOrder(captured.body);

  return {
    _version: version,
    _captured: new Date().toISOString(),
    _source: 'live',
    _schemaVersion: CURRENT_SCHEMA_VERSION,
    agent_identity: agentIdentity,
    system_prompt: systemPrompt,
    tools,
    tool_names: tools.map((t) => t.name),
    header_order: headerOrder,
    anthropic_beta: typeof anthropicBeta === 'string' ? anthropicBeta : undefined,
    header_values: Object.keys(headerValues).length > 0 ? headerValues : undefined,
    body_field_order: bodyFieldOrder,
  };
}

/**
 * Capture the top-level key order of a parsed body. Returns undefined when
 * the object is empty or not an object, so the reorder helper in
 * cc-template.ts falls back to its hardcoded build order.
 */
function extractBodyFieldOrder(body: Record<string, unknown> | undefined): string[] | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const keys = Object.keys(body);
  return keys.length > 0 ? keys : undefined;
}

/**
 * Pick header values from the captured request that CC would set identically
 * on every outbound call. The replayer overlays these on top of whatever the
 * caller supplied, so anything session-scoped, auth-bearing, or computed by
 * the HTTP stack itself must be excluded.
 */
const STATIC_HEADER_EXCLUDE = new Set<string>([
  // Auth — never replay across identities
  'authorization',
  // x-api-key is a CAPTURE ARTIFACT (dario#42). During capture we spawn CC
  // with ANTHROPIC_API_KEY=sk-dario-fingerprint-capture pointing at a loopback
  // MITM, so CC emits `x-api-key: sk-dario-fingerprint-capture`. Replaying
  // that placeholder upstream alongside the real OAuth Bearer used to be a
  // no-op because Anthropic ignored x-api-key when Authorization was present;
  // as of 2026-04-17 some account tiers now 401 with "invalid x-api-key" when
  // both are sent. Never capture it.
  'x-api-key',
  // Body-framing — computed per request
  'content-type', 'content-length', 'transfer-encoding',
  // Host / connection — managed by the HTTP stack
  'host', 'connection', 'keep-alive', 'accept-encoding',
  // Session / request identifiers — rotate per call
  'x-claude-code-session-id', 'x-client-request-id', 'x-request-id',
  // Beta flag is captured separately
  'anthropic-beta',
  // Billing tag — rebuilt per request from cc_version
  'x-anthropic-billing-header',
  // HOST-SPECIFIC (dario#854 fallout). These describe the machine that ran the
  // capture, not CC's wire shape, so replaying them makes every consumer of a
  // baked template announce the BAKE host's platform instead of its own. The
  // proxy already computes both correctly per-process (OS_NAME / arch), and the
  // overlay used to clobber those with the captured values.
  //
  // Found 2026-07-25: the bundled template had been baked on Windows for
  // several releases (#820/#828/#840/#849/#851 -> x-stainless-os: Windows,
  // 30 tools incl. PowerShell), while cc-drift-template-watch runs its live
  // capture every 30 min on the Linux Hetzner runner. So the Linux box served
  // `x-stainless-os: Windows`, and the watch saw permanent drift against a
  // bundle it could never match -- auto-rebaking to Linux (#852), which the next
  // Windows-side bake (#854) would flip straight back. Excluding these ends
  // both the fidelity bug and the rebake ping-pong: the bake host stops
  // mattering for these keys.
  'x-stainless-os',
  'x-stainless-arch',
]);

function extractStaticHeaderValues(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (STATIC_HEADER_EXCLUDE.has(lk)) continue;
    if (typeof v !== 'string') continue;
    out[lk] = v;
  }
  return out;
}

// ============================================================
//  Drift detection + startup diagnostics (v3.17)
// ============================================================

let _installedVersionProbe: { value: string | null; cached: boolean } = { value: null, cached: false };

/**
 * Sync-probe `claude --version` and return the parsed version string, e.g.
 * `"2.1.104"`. Memoized per-process — the binary is invoked at most once,
 * subsequent calls return the cached result. Returns `null` if the binary
 * isn't on PATH, or the probe failed / timed out, or the output didn't
 * match the expected format.
 *
 * Used by `detectDrift` to compare the installed CC against the version
 * recorded in the cache at capture time.
 */
export function probeInstalledCCVersion(): string | null {
  if (_installedVersionProbe.cached) return _installedVersionProbe.value;
  const value = probeInstalledCCVersionUncached();
  _installedVersionProbe = { value, cached: true };
  return value;
}

function probeInstalledCCVersionUncached(): string | null {
  const bin = findClaudeBinary();
  if (!bin) return null;
  try {
    // Node 20+ refuses to spawn `.cmd`/`.bat` via execFile without
    // explicit `shell: true` (CVE-2024-27980 hardening). On Windows,
    // npm-installed CLIs commonly live behind a `.cmd` shim — detect
    // that and opt into the shell path.
    //
    // `bin` is normally from findClaudeBinary's fixed allow-list, but
    // DARIO_CLAUDE_BIN lets users override it. If that override reaches
    // the shell path, cmd.exe interprets its contents — so reject any
    // override that carries shell metacharacters before we spawn.
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
    if (useShell && /[&|><^"'%\r\n`$;(){}[\]]/.test(bin)) {
      return null;
    }
    const out = execFileSync(bin, ['--version'], {
      encoding: 'utf-8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      shell: useShell,
    });
    // `claude --version` currently prints e.g. `1.0.79 (Claude Code)` or
    // `claude-cli 2.1.104`. Accept anything that contains a dotted numeric
    // version — the first match wins.
    const m = /(\d+\.\d+\.\d+(?:[.\-][\w.\-]+)?)/.exec(out);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Format how old a captured timestamp is, human-readable. `_captured` is
 * an ISO string written by `extractTemplate` or the bundled snapshot.
 * Falls back to `"unknown age"` if the timestamp doesn't parse.
 */
export function formatCaptureAge(capturedIso: string, now: number = Date.now()): string {
  const t = Date.parse(capturedIso);
  if (!Number.isFinite(t)) return 'unknown age';
  const ageMs = Math.max(0, now - t);
  const s = Math.floor(ageMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

/**
 * One-line human summary of the active template — what source, which CC
 * version captured it, and how old that capture is. Proxy startup logs
 * this so users can tell at a glance whether they're on a fresh live
 * capture or a stale bundled fallback.
 */
export function describeTemplate(t: TemplateData): string {
  const source = t._source ?? 'bundled';
  const age = formatCaptureAge(t._captured);
  // Variant coverage is part of the template's identity: a template that
  // lost its per-model variants serves every family the base prompt, and
  // that degradation is otherwise invisible (dario#lock-step).
  const keys = Object.keys(promptVariantsOf(t)).sort();
  const variants = keys.length > 0 ? keys.join('+') : 'none';
  // Attribution, not just coverage. `variants:` names what the SERVED template
  // has, and on a live capture that is very often the bundle's — a live cache
  // carries no variants at all until a runtime variant sweep has run, and it
  // carries a headless subset of the tools always. Reporting the merged totals
  // and calling the result a live capture is how a halved tool list read as
  // healthy for a release. Both counts are suppressed when the bundle
  // contributed nothing, so the common healthy line stays short.
  const from = t._fromBundle;
  const parts = [
    `${source} capture, CC v${t._version} (${age} old)`,
    `variants: ${variants}`
    + (from && from.variants.length > 0 ? ` (${from.variants.length}/${keys.length} bundled)` : ''),
    `tools: ${t.tools?.length ?? 0}`
    + (from && from.tools.length > 0 ? ` (${from.tools.length} bundled)` : ''),
  ];
  return parts.join(', ');
}

export interface DriftResult {
  /** True when we can confirm the cache is from a different CC version than the one currently installed. */
  drifted: boolean;
  cachedVersion: string;
  /** null when the probe couldn't run (no CC on PATH, timeout, parse fail). */
  installedVersion: string | null;
  /** Reason string — safe to log as-is. */
  message: string;
}

/**
 * Compare the loaded template's captured CC version against the version
 * reported by `claude --version` on the current machine. Drifted caches
 * are still usable — the shape is probably compatible — but the proxy
 * should force-refresh ASAP so the next startup is back in sync.
 *
 * @param installedOverride test-only injection for unit tests; production
 *   callers pass nothing and the real binary probe runs.
 */
export function detectDrift(t: TemplateData, installedOverride?: string | null): DriftResult {
  const installed = installedOverride !== undefined ? installedOverride : probeInstalledCCVersion();
  const cachedVersion = t._version;
  if (installed === null) {
    return {
      drifted: false,
      cachedVersion,
      installedVersion: null,
      message: 'installed CC version not probed (binary not on PATH or probe failed)',
    };
  }
  if (installed === cachedVersion) {
    return {
      drifted: false,
      cachedVersion,
      installedVersion: installed,
      message: `cache matches installed CC (v${installed})`,
    };
  }
  return {
    drifted: true,
    cachedVersion,
    installedVersion: installed,
    message: `cache is from CC v${cachedVersion} but installed CC is v${installed} — background refresh will re-capture`,
  };
}

// ============================================================
//  CC version compat matrix (v3.17)
// ============================================================

/**
 * The CC version range the current dario release has been exercised
 * against. Update `maxTested` every time we validate against a new CC
 * (ideally as part of the release checklist — the e2e test against the
 * user's own CC is the ground-truth signal).
 *
 * - `min`: below this, dario's extractor hasn't been validated; proxy
 *   will still run but may mis-parse CC's request body.
 * - `maxTested`: the newest CC version the current dario release has
 *   been exercised against. Above this, dario is *likely* fine (CC's
 *   request shape evolves slowly) but it's explicitly untested, so
 *   users get a soft warn and we get a signal to refresh the bundled
 *   snapshot + rerun e2e.
 */
export const SUPPORTED_CC_RANGE = {
  min: '1.0.0',
  maxTested: '2.1.236',
} as const;

/**
 * Compare two dotted-numeric version strings. Returns negative if `a<b`,
 * zero if equal, positive if `a>b`. Handles suffixes like `-beta.1` or
 * `.dev` by comparing the numeric prefix first and treating anything
 * after as a tiebreaker (strings compared lexicographically; absence of
 * suffix beats presence, matching semver's "release > prerelease").
 *
 * Intentionally minimal — dario's "zero runtime deps" policy rules out
 * pulling `semver`. CC versions are well-formed `M.m.p[-suffix]` so we
 * don't need the full spec.
 */
export function compareVersions(a: string, b: string): number {
  const splitPrefixSuffix = (v: string): { parts: number[]; suffix: string } => {
    const m = /^(\d+(?:\.\d+)*)(.*)$/.exec(v);
    if (!m) return { parts: [0], suffix: v };
    const parts = m[1].split('.').map((s) => parseInt(s, 10));
    return { parts, suffix: m[2] ?? '' };
  };
  const A = splitPrefixSuffix(a);
  const B = splitPrefixSuffix(b);
  const len = Math.max(A.parts.length, B.parts.length);
  for (let i = 0; i < len; i++) {
    const ai = A.parts[i] ?? 0;
    const bi = B.parts[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  // Numeric prefix equal — compare suffix. Empty suffix beats non-empty
  // (release > prerelease). Otherwise lexicographic.
  if (A.suffix === B.suffix) return 0;
  if (A.suffix === '') return 1;
  if (B.suffix === '') return -1;
  return A.suffix < B.suffix ? -1 : 1;
}

export type CompatStatus = 'ok' | 'untested-above' | 'below-min' | 'unknown';

export interface CompatResult {
  status: CompatStatus;
  installedVersion: string | null;
  range: { min: string; maxTested: string };
  message: string;
}

/**
 * Check whether the installed CC version sits inside the supported range.
 * Called at startup by the proxy; the result drives whether we emit a
 * compatibility warning to the user.
 *
 * `unknown` is not a failure — it just means we couldn't probe (no CC on
 * PATH, timeout, parse miss). Dario still runs on bundled template.
 *
 * @param installedOverride test-only injection; production callers pass nothing.
 */
export function checkCCCompat(installedOverride?: string | null): CompatResult {
  const installed = installedOverride !== undefined ? installedOverride : probeInstalledCCVersion();
  const range = { min: SUPPORTED_CC_RANGE.min, maxTested: SUPPORTED_CC_RANGE.maxTested };
  if (installed === null) {
    return {
      status: 'unknown',
      installedVersion: null,
      range,
      message: 'installed CC version not probed — compatibility unchecked',
    };
  }
  if (compareVersions(installed, range.min) < 0) {
    return {
      status: 'below-min',
      installedVersion: installed,
      range,
      message: `installed CC v${installed} is older than the minimum dario supports (v${range.min}); extractor may mis-parse requests — upgrade CC`,
    };
  }
  if (compareVersions(installed, range.maxTested) > 0) {
    return {
      status: 'untested-above',
      installedVersion: installed,
      range,
      message: `installed CC v${installed} is newer than dario's last tested version (v${range.maxTested}); usually fine, but untested`,
    };
  }
  return {
    status: 'ok',
    installedVersion: installed,
    range,
    message: `installed CC v${installed} is within the tested range (v${range.min} – v${range.maxTested})`,
  };
}

/**
 * Walk rawHeaders (flat [k1, v1, k2, v2, ...] array) and return the
 * header names in insertion order, lowercased, de-duplicated. If the
 * raw array is empty or unusable, returns undefined so the caller
 * falls back to default ordering.
 */
function extractHeaderOrder(rawHeaders: string[]): string[] | undefined {
  if (!Array.isArray(rawHeaders) || rawHeaders.length === 0) return undefined;
  const order: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    if (typeof name !== 'string') continue;
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    order.push(lower);
  }
  return order.length > 0 ? order : undefined;
}

function pickTextBlock(block: unknown): string | null {
  if (!block || typeof block !== 'object') return null;
  const b = block as { type?: string; text?: string };
  if (b.type === 'text' && typeof b.text === 'string') return b.text;
  return null;
}

function extractCCVersion(headers: Record<string, string>): string | null {
  // Preferred: x-anthropic-billing-header carries cc_version=X.Y.Z
  const billing = headers['x-anthropic-billing-header'];
  if (billing) {
    const m = /cc_version=([\w.\-]+)/.exec(billing);
    if (m) return m[1];
  }
  // Fallback: user-agent often carries claude-cli/X.Y.Z
  const ua = headers['user-agent'];
  if (ua) {
    const m = /claude-cli\/([\w.\-]+)/.exec(ua);
    if (m) return m[1];
  }
  return null;
}

/**
 * Test hook: given a captured request object (from a mocked server or a
 * synthetic fixture), run it through the same extraction path. Exposed so
 * test/live-fingerprint.mjs doesn't need to spawn a real process.
 */
export function _extractTemplateForTest(captured: CapturedRequest): TemplateData | null {
  return extractTemplate(captured);
}
