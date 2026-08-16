/**
 * CC sub-agent hook (v3.26, direction #2).
 *
 * Claude Code reads sub-agent definitions from `~/.claude/agents/*.md` —
 * a YAML-frontmatter markdown file that exposes a tool-scoped prompt
 * context CC can delegate work into. Installing a "dario" sub-agent
 * gives the user (or CC itself, via the Task tool) a named handle to
 * delegate dario operations into: refreshing the baked template from
 * a live capture, checking proxy health, listing pool / backend state.
 *
 * The sub-agent runs with Bash + Read tool access only — it can invoke
 * the `dario` CLI to produce reports, but it cannot modify dario state
 * (accounts add/remove, backend configuration, etc.) without the user
 * explicitly running those commands in their own session. That boundary
 * is baked into the prompt so the sub-agent doesn't accidentally take
 * destructive actions on the user's behalf.
 *
 * The file content is versioned via an inline `dario-sub-agent-version:`
 * marker so a later release can detect stale installations (same axis as
 * the `_schemaVersion` check on the live-fingerprint cache). `readStatus`
 * is pure over `(fileExists, fileBody)` so the tests exercise every
 * branch without touching the filesystem.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeDir } from './home-dir.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SUBAGENT_NAME = 'dario';
export const SUBAGENT_FILENAME = `${SUBAGENT_NAME}.md`;

/** `~/.claude/agents/dario.md`. */
export function getSubagentPath(): string {
  return join(homeDir(), '.claude', 'agents', SUBAGENT_FILENAME);
}

/**
 * Construct the full sub-agent file body for a given dario version. Pure
 * function — the tests pin the output so a change to the content is a
 * deliberate, diffable update.
 */
export function buildSubagentFile(darioVersion: string): string {
  return `---
name: ${SUBAGENT_NAME}
description: Use this sub-agent for dario-related diagnostics and template-refresh operations. It can invoke the \`dario\` CLI (via Bash) to run a health report, refresh the baked CC request template from a live capture, or check the proxy's account pool and backend configuration. It will not modify dario state (credentials, accounts, backends) without explicit user authorization.
tools: Bash, Read
---

<!-- dario-sub-agent-version: ${darioVersion} -->
<!-- managed by: dario subagent install / remove -->

You are **dario's integration sub-agent**. You have access to the \`dario\` CLI via the Bash tool. Your job is to help the user with dario-related diagnostics and refresh operations by running read-only or user-requested commands and summarizing the output.

## What you can do (read-only — no user confirmation required)

- **\`dario doctor\`** — produce a health report covering Node / platform, runtime TLS fingerprint, CC binary + compatibility range, template source + drift, OAuth state, account pool, and backend configuration. Summarize any \`[WARN]\` or \`[FAIL]\` rows in plain language and suggest the fix hinted in the detail column.
- **\`dario status\`** — quick auth status (authenticated, expires in, claim).
- **\`dario accounts list\`** — list the configured account pool and per-account token expiry.
- **\`dario backend list\`** — list configured OpenAI-compat backends (OpenRouter, Groq, LiteLLM, etc.).
- **\`dario --version\`** — report the installed dario version.

## What requires explicit user authorization first

Before invoking any of these, ask the user to confirm:

- \`dario login\` / \`dario refresh\` — mutates credentials.
- \`dario accounts add/remove\` — mutates the account pool.
- \`dario backend add/remove\` — mutates backend configuration.
- \`dario logout\` — deletes stored credentials.

## What you should NOT do

- Do not run \`dario proxy\` — the proxy is a long-running server; invoking it from a sub-agent context would block the parent CC session indefinitely.
- Do not modify \`~/.dario/\` files directly (credentials.json, accounts/, backends.json). Use the CLI.
- Do not dump credentials, tokens, or bearer values in your output.

## Style

- Lead with the headline answer (one line).
- For diagnostics, group findings by severity (FAIL → WARN → OK).
- When suggesting a fix, quote the exact command the user should run.
- Keep output concise — the user is delegating to you because they want a summary, not a transcript.
`;
}

export interface SubagentStatus {
  installed: boolean;
  path: string;
  /** Parsed from the inline `dario-sub-agent-version:` marker when the file is present. */
  fileVersion: string | null;
  /** Whether the installed file matches the version currently being built. */
  current: boolean;
  /** Whether `~/.claude/agents/` exists (is CC installed / agents dir created?). */
  agentsDirExists: boolean;
}

/**
 * Pure status computation over (fileExists, fileBody, currentVersion).
 * Separated from `loadStatus` so tests can feed synthetic bodies and
 * exercise every branch without the filesystem.
 */
export function computeSubagentStatus(
  path: string,
  fileExists: boolean,
  fileBody: string | null,
  agentsDirExists: boolean,
  currentVersion: string,
): SubagentStatus {
  if (!fileExists || fileBody === null) {
    return { installed: false, path, fileVersion: null, current: false, agentsDirExists };
  }
  const m = /<!-- dario-sub-agent-version: ([^ ]+) -->/.exec(fileBody);
  const fileVersion = m ? m[1]! : null;
  const current = fileVersion === currentVersion;
  return { installed: true, path, fileVersion, current, agentsDirExists };
}

/**
 * Read the current on-disk status. Safe to call whether or not
 * `~/.claude/` exists; a missing directory is reported via
 * `agentsDirExists: false` so the caller can decide whether to create it
 * (install) or just skip (status).
 */
export function loadSubagentStatus(): SubagentStatus {
  const path = getSubagentPath();
  const agentsDir = dirname(path);
  const agentsDirExists = existsSync(agentsDir);
  const fileExists = existsSync(path);
  let fileBody: string | null = null;
  if (fileExists) {
    try { fileBody = readFileSync(path, 'utf-8'); }
    catch { fileBody = null; }
  }
  return computeSubagentStatus(path, fileExists, fileBody, agentsDirExists, currentDarioVersion());
}

/**
 * Install or refresh the sub-agent. Creates `~/.claude/agents/` if it
 * doesn't exist. Returns what happened so the CLI can log accurately.
 */
export function installSubagent(): { path: string; action: 'created' | 'updated' | 'unchanged'; version: string } {
  const path = getSubagentPath();
  const agentsDir = dirname(path);
  if (!existsSync(agentsDir)) {
    mkdirSync(agentsDir, { recursive: true });
  }
  const version = currentDarioVersion();
  const desired = buildSubagentFile(version);

  let existingBody: string | null = null;
  const exists = existsSync(path);
  if (exists) {
    try { existingBody = readFileSync(path, 'utf-8'); } catch { existingBody = null; }
  }

  if (existingBody === desired) {
    return { path, action: 'unchanged', version };
  }
  writeFileSync(path, desired, 'utf-8');
  return { path, action: exists ? 'updated' : 'created', version };
}

/**
 * Remove the sub-agent file. Idempotent — returns `{ removed: false }`
 * if the file wasn't present. Does not remove the parent `~/.claude/agents/`
 * directory even if it becomes empty (user may have other sub-agents).
 */
export function removeSubagent(): { path: string; removed: boolean } {
  const path = getSubagentPath();
  if (!existsSync(path)) return { path, removed: false };
  unlinkSync(path);
  return { path, removed: true };
}

function currentDarioVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
