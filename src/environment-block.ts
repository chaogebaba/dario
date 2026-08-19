/**
 * CC's `# Environment` section, rewritten to describe the machine dario is
 * actually running on and the model actually being served.
 *
 * Real Claude Code composes this section per session from its own runtime.
 * dario replays a captured prompt, so whatever the capture saw is what every
 * later request repeats. The capture runs `claude` in a throwaway config home
 * (`live-fingerprint.ts`), which produced this on the audit machine:
 *
 *     - Primary working directory: /tmp/dario-capture-cGZjcC
 *     - Is a git repository: false
 *     - You are powered by the model named Opus 4.8. …
 *
 * A cwd under `/tmp` with git unavailable is a shape no interactive session
 * has, the directory stops existing the moment the capture ends, and the model
 * line is asserted to every model dario serves — a haiku request was told it
 * was Opus 4.8. The section is also absent from the bundled prompt variants,
 * because the bake scrubs host context before publishing, so an opus-5 request
 * got no environment at all where real CC always sends one.
 *
 * The rule here is REWRITE, NEVER INVENT. Every line CC authored — the model
 * catalog, the CC-availability blurb, the fast-mode note — is passed through
 * untouched, because dario has no source for that prose other than the CC
 * binary that produced it. Only the lines describing the host or the model are
 * replaced, and only from facts read off the running system. Where a fact
 * cannot be sourced the line is left exactly as captured.
 *
 * Two lines are model-specific. The model line dario can rebuild, because it
 * knows what it is serving. The other is the knowledge
 * cutoff: the capture ran under opus-4-8 and says "January 2026", while a real
 * opus-5 session says "May 2026". Restating the capture's answer for a
 * different model would be a fresh fabrication of precisely the kind this
 * module exists to remove, so the line is dropped when the served model is not
 * the captured one. A missing line beats a false one, and the shape delta is
 * free: system prompt content and length are not billing-classifier inputs
 * (docs/research/system-prompt-classifier-study.md).
 *
 * Pure over its inputs — every fact is passed in explicitly — so the tests can
 * exercise each host and model combination without touching the real system.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { release, type as osType } from 'node:os';

/** The host- and model-specific values CC writes into the section. */
export interface EnvironmentFacts {
  cwd: string;
  isGitRepo: boolean;
  platform: string;
  /** Bare shell name, as CC writes it ("zsh"). `null` leaves the line as captured. */
  shell: string | null;
  /** `${os.type()} ${os.release()}`, e.g. "Linux 7.1.8-200.fc44.x86_64". */
  osVersion: string;
  /** Display name, e.g. "Opus 5 (1M context)". `null` drops the model line. */
  modelName: string | null;
  /** The id exactly as it goes on the wire. */
  modelId: string;
}

/**
 * CC's display name for a model id, or null when the id is not a shape CC
 * names. Null means "leave the captured line alone" — guessing a name is the
 * failure this module removes.
 *
 *   claude-opus-4-8              → Opus 4.8
 *   claude-opus-5[1m]            → Opus 5 (1M context)
 *   claude-haiku-4-5-20251001    → Haiku 4.5
 *   claude-3-5-sonnet-20241022   → null (pre-family id shape)
 */
export function modelDisplayName(modelId: string): string | null {
  let id = modelId.trim();
  if (!id) return null;
  // Provider-prefixed ids reach some code paths as "anthropic/claude-opus-5".
  const slash = id.lastIndexOf('/');
  if (slash >= 0) id = id.slice(slash + 1);

  let suffix = '';
  const long = /\[1m\]$/i.exec(id);
  if (long) {
    suffix = ' (1M context)';
    id = id.slice(0, long.index);
  }
  // Trailing release date is not part of the name CC prints.
  id = id.replace(/-\d{8}$/, '');

  const m = /^claude-([a-z]+)-(\d+(?:-\d+)*)$/.exec(id.toLowerCase());
  if (!m) return null;
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return `${family} ${m[2].replace(/-/g, '.')}${suffix}`;
}

/**
 * Two model ids naming the same model for the purpose of the cutoff line:
 * the release-date and `[1m]` suffixes do not change the answer.
 */
export function sameModel(a: string, b: string): boolean {
  const norm = (v: string) => v.trim().toLowerCase()
    .replace(/^.*\//, '')
    .replace(/\[1m\]$/, '')
    .replace(/-\d{8}$/, '');
  return norm(a) === norm(b) && norm(a).length > 0;
}

/**
 * Whether `dir` sits inside a git working tree. Walks up rather than shelling
 * out: this runs on the request path, and `.git` is a file in a worktree or a
 * submodule, so `existsSync` alone answers it.
 */
export function isInsideGitRepo(dir: string): boolean {
  let cur = dir;
  for (;;) {
    if (existsSync(join(cur, '.git'))) return true;
    const parent = dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

/** Read the host half of the facts off the running system. */
export function detectEnvironmentFacts(
  modelId: string,
  deps: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): EnvironmentFacts {
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const shellPath = env.SHELL?.trim();
  return {
    cwd,
    isGitRepo: isInsideGitRepo(cwd),
    platform: process.platform,
    shell: shellPath ? shellPath.slice(shellPath.lastIndexOf('/') + 1) : null,
    osVersion: `${osType()} ${release()}`,
    modelName: modelDisplayName(modelId),
    modelId,
  };
}

const ENV_HEADING = '# Environment';

/**
 * The `# Environment` section of `prompt`, heading included and trailing blank
 * line excluded, or null when there is none. The section runs to the next
 * top-level heading, the same boundary `scrub-template.ts` uses.
 */
export function extractEnvironmentSection(prompt: string): string | null {
  const start = prompt.indexOf(`${ENV_HEADING}\n`);
  if (start < 0) return null;
  const next = prompt.indexOf('\n# ', start + ENV_HEADING.length);
  const end = next < 0 ? prompt.length : next;
  return prompt.slice(start, end).replace(/\s+$/, '');
}

/** The model id the captured block was recorded under, if it names one. */
export function capturedModelId(block: string): string | null {
  const m = /The exact model ID is ([^\s.]+)\./.exec(block);
  return m ? m[1] : null;
}

/**
 * Rewrite the host- and model-specific lines of a captured block. Line-keyed
 * on CC's own prefixes, so any line CC adds in a future build passes through
 * rather than being dropped by a whole-block re-render.
 *
 * `keepCutoff` is false when the served model is not the captured one; that
 * line is then removed rather than restated.
 */
export function rewriteEnvironmentBlock(
  block: string,
  facts: EnvironmentFacts,
  keepCutoff: boolean,
): string {
  const out: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(' - Primary working directory: ')) {
      out.push(` - Primary working directory: ${facts.cwd}`);
    } else if (line.startsWith(' - Is a git repository: ')) {
      out.push(` - Is a git repository: ${facts.isGitRepo}`);
    } else if (line.startsWith(' - Platform: ')) {
      out.push(` - Platform: ${facts.platform}`);
    } else if (line.startsWith(' - Shell: ')) {
      out.push(facts.shell ? ` - Shell: ${facts.shell}` : line);
    } else if (line.startsWith(' - OS Version: ')) {
      out.push(` - OS Version: ${facts.osVersion}`);
    } else if (line.startsWith(' - You are powered by the model named ')) {
      // Rewrite the two values in place and keep whatever else CC put in the
      // sentence — on this capture it ends there, but the tail is CC's prose.
      //
      // An id with no derivable name drops the line rather than keeping the
      // captured one, on the same rule as the cutoff below: never restate a
      // model-specific line for a different model. The pattern is generic over
      // `claude-<family>-<version>`, so a Claude family that does not exist
      // yet still parses; what falls through here is an id CC would not be
      // serving at all.
      if (facts.modelName) {
        out.push(line.replace(
          /^ - You are powered by the model named .*?\. The exact model ID is [^\s.]+\./,
          ` - You are powered by the model named ${facts.modelName}. The exact model ID is ${facts.modelId}.`,
        ));
      }
    } else if (line.startsWith(' - Assistant knowledge cutoff is ')) {
      if (keepCutoff) out.push(line);
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

/**
 * Put `block` into `prompt`, replacing an existing `# Environment` section or
 * inserting one where CC puts it.
 *
 * CC emits `# Environment` immediately before `# Context management` —
 * verified on two independently produced prompts, the opus-4-8 capture and a
 * live opus-5 session. With no `# Context management` to anchor on the block
 * goes last, which is where CC's host-context sections sit.
 */
export function spliceEnvironmentSection(prompt: string, block: string): string {
  const start = prompt.indexOf(`${ENV_HEADING}\n`);
  if (start >= 0) {
    const next = prompt.indexOf('\n# ', start + ENV_HEADING.length);
    const end = next < 0 ? prompt.length : next;
    return prompt.slice(0, start) + block + prompt.slice(end);
  }
  const anchor = prompt.indexOf('\n# Context management\n');
  if (anchor >= 0) return `${prompt.slice(0, anchor + 1)}${block}\n\n${prompt.slice(anchor + 1)}`;
  return `${prompt.replace(/\s+$/, '')}\n\n${block}\n`;
}

/**
 * Give `prompt` an `# Environment` section describing this host and `modelId`,
 * modelled on `captured`.
 *
 * `captured` is the block a real CC produced on this machine; without one
 * there is nothing to model and the prompt is returned untouched, which is
 * every install that has never run a live capture.
 */
export function applyEnvironmentSection(
  prompt: string,
  captured: string | null,
  modelId: string,
  deps: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  if (!captured) return prompt;
  const facts = detectEnvironmentFacts(modelId, deps);
  const capturedId = capturedModelId(captured);
  const keepCutoff = capturedId !== null && sameModel(capturedId, modelId);
  return spliceEnvironmentSection(prompt, rewriteEnvironmentBlock(captured, facts, keepCutoff));
}
