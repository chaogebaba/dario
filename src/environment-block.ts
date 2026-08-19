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
 * The same module handles CC's `gitStatus:` block, which it appends after the
 * last heading whenever the working directory is a git repository. That block
 * had no captured shape at all until the capture sandbox was made a repo
 * (`live-fingerprint.ts:seedCaptureRepo`), because a bare `/tmp` directory
 * makes CC emit nothing. With a shape to model, the branch, main branch, git
 * user, status and recent commits are substituted from the serving host's own
 * repository, and a host that is not in one drops the block entirely — which
 * is what CC does there too.
 *
 * One cost worth naming: the system prompt carries `cache_control: ephemeral`,
 * so a gitStatus that moves invalidates a ~25KB cached block. It only moves
 * when the repository actually changes, and the caller snapshots on a TTL no
 * shorter than the cache's own lifetime, which bounds the churn to at most one
 * extra miss per cache generation.
 *
 * Pure over its inputs — every fact is passed in explicitly — so the tests can
 * exercise each host and model combination without touching the real system.
 */

import { execFileSync } from 'node:child_process';
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

// ── CC's gitStatus block ─────────────────────────────────────────────

/**
 * The values CC writes into `gitStatus:`, read off a real repository.
 *
 * `status` and `recentCommits` are the raw multi-line bodies, already
 * trimmed. An empty `status` means a clean tree, which CC renders with its own
 * literal rather than an empty list — see `rewriteGitStatusBlock`.
 */
export interface GitStatusFacts {
  branch: string;
  /**
   * The branch CC names as the PR target. Measured against CC 2.1.236: `main`
   * when the repo has one, `master` when it has only that, and `main` when it
   * has neither — a repo on `trunk` with no main and no master is still told
   * `main`.
   */
  mainBranch: string;
  /**
   * `git config user.name`, or null where none is set — a container, a CI
   * runner, a machine whose identity lives only in per-repo config. The
   * section is dropped rather than guessed, and the rest of the block still
   * renders; losing all of it over one unset field is how a sandboxed HOME
   * first surfaced this.
   */
  user: string | null;
  /** `git status --porcelain`, empty when the tree is clean. */
  status: string;
  /** `git log --oneline -5`. */
  recentCommits: string;
}

const GIT_STATUS_LABEL = 'gitStatus:';

/**
 * Read the git half of the facts off the repository at `cwd`, or null when
 * there is no repository, no git, or any command fails.
 *
 * Null is a real answer, not a degraded one: it means the block is dropped,
 * which is what CC sends outside a working tree.
 *
 * Runs on a snapshot cadence, not per request — CC itself describes the block
 * as "the git status at the start of the conversation", and the caller
 * memoizes accordingly.
 */
export function detectGitStatusFacts(cwd: string): GitStatusFacts | null {
  // Trailing whitespace only. `git status --porcelain` puts the two-column
  // XY code in the first two characters, so an unstaged edit reads " M path"
  // — a full trim eats that leading space on the FIRST line alone and sends a
  // status list whose first row is shaped differently from the rest.
  const git = (...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    timeout: 5_000,
    // A repository with a busy index must not make dario hang or log; the
    // read-only commands here do not need the lock.
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'ignore'],
  }).replace(/\s+$/, '');
  // Every field but the branch degrades on its own: an unset user.name, a
  // repository with no commits yet, a `git status` that fails on a permission
  // error. Each of those still leaves a block CC would have sent, minus a
  // section — which is the module's standing rule for a fact it cannot source.
  const tryGit = (...args: string[]): string | null => {
    try {
      return git(...args);
    } catch {
      return null;
    }
  };
  const branchExists = (name: string): boolean => tryGit('rev-parse', '--verify', '--quiet', `refs/heads/${name}`) !== null;
  try {
    // Not a repo, or no git at all. CC sends no block from there either, and
    // an unforeseen git failure must cost this block rather than the request —
    // this runs on the request path.
    if (tryGit('rev-parse', '--is-inside-work-tree')?.trim() !== 'true') return null;
    // `--abbrev-ref HEAD` names a detached HEAD as `HEAD` but fails outright on
    // a repository with no commits, where `--show-current` still names the
    // unborn branch. Between them there is always an answer, and without one
    // there is no block to render.
    const branch = tryGit('rev-parse', '--abbrev-ref', 'HEAD')?.trim()
      || tryGit('branch', '--show-current')?.trim();
    if (!branch) return null;
    return {
      branch,
      mainBranch: branchExists('main') ? 'main' : branchExists('master') ? 'master' : 'main',
      user: tryGit('config', 'user.name')?.trim() || null,
      status: tryGit('status', '--porcelain') ?? '',
      recentCommits: tryGit('log', '--oneline', '-5') ?? '',
    };
  } catch {
    return null;
  }
}

/**
 * The `gitStatus:` block of `prompt`, or null when there is none.
 *
 * CC appends it after the last heading, so the block runs to the next
 * top-level heading or to the end — the same boundary `scrub-template.ts`
 * strips on.
 */
export function extractGitStatusBlock(prompt: string): string | null {
  const at = prompt.indexOf(`\n${GIT_STATUS_LABEL}`);
  if (at < 0) return null;
  const start = at + 1;
  const next = prompt.indexOf('\n# ', start);
  const end = next < 0 ? prompt.length : next;
  return prompt.slice(start, end).replace(/\s+$/, '');
}

/**
 * Rewrite a captured `gitStatus:` block to describe the repository at hand.
 *
 * Section-keyed on CC's own labels, for the same reason the environment
 * rewrite is line-keyed: a section CC adds later passes through untouched
 * rather than being dropped by a whole-block re-render. The preamble sentence
 * is CC's prose and is never touched.
 *
 * Three sections have an empty case. An unset `user.name` drops its own
 * section and leaves the rest standing. The other two resolve opposite ways: a clean
 * tree leaves CC's own rendering of one standing — the capture sandbox is
 * seeded clean precisely so that word is `(clean)` and not a stale file list.
 * A repository with no commits drops the section instead, because the captured
 * list names commits that are not this repository's, and restating them would
 * be the fabrication this module exists to remove.
 */
export function rewriteGitStatusBlock(block: string, facts: GitStatusFacts): string {
  const out: string[] = [];
  for (const section of block.split('\n\n')) {
    if (section.startsWith('Current branch: ')) {
      out.push(`Current branch: ${facts.branch}`);
    } else if (/^Main branch \(.*\): /.test(section)) {
      out.push(section.replace(/^(Main branch \(.*\): ).*$/, `$1${facts.mainBranch}`));
    } else if (section.startsWith('Git user: ')) {
      if (facts.user) out.push(`Git user: ${facts.user}`);
    } else if (section === 'Status:' || section.startsWith('Status:\n')) {
      out.push(facts.status ? `Status:\n${facts.status}` : section);
    } else if (section === 'Recent commits:' || section.startsWith('Recent commits:\n')) {
      if (facts.recentCommits) out.push(`Recent commits:\n${facts.recentCommits}`);
    } else {
      out.push(section);
    }
  }
  return out.join('\n\n');
}

/**
 * Put `block` at the end of `prompt`, replacing an existing `gitStatus:` block.
 * A null block removes one — the case where dario is not serving from a
 * repository and CC would send none.
 */
export function spliceGitStatusBlock(prompt: string, block: string | null): string {
  const at = prompt.indexOf(`\n${GIT_STATUS_LABEL}`);
  if (at >= 0) {
    const next = prompt.indexOf('\n# ', at + 1);
    const end = next < 0 ? prompt.length : next;
    const head = block === null ? prompt.slice(0, at) : `${prompt.slice(0, at + 1)}${block}`;
    return head + prompt.slice(end);
  }
  if (block === null) return prompt;
  return `${prompt.replace(/\s+$/, '')}\n\n${block}`;
}

/**
 * Give `prompt` the `gitStatus:` block CC would send from this host, modelled
 * on `captured`.
 *
 * With no captured block there is nothing to model and the prompt is returned
 * untouched. With no facts — dario serving from outside a repository — any
 * block already in the prompt is removed, since that is what CC does there.
 */
export function applyGitStatusBlock(
  prompt: string,
  captured: string | null,
  facts: GitStatusFacts | null,
): string {
  if (!captured) return prompt;
  if (!facts) return spliceGitStatusBlock(prompt, null);
  return spliceGitStatusBlock(prompt, rewriteGitStatusBlock(captured, facts));
}
