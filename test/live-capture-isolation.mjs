// Live-capture isolation — the capture MITM must be un-hijackable.
//
// dario spawns `claude --print -p 'hi'` at a loopback MITM to capture the
// wire shape. That probe is supposed to cost nothing: the MITM answers with
// a canned SSE stream and never forwards upstream.
//
// It did not hold. CC's ~/.claude/settings.json `env` block takes precedence
// over the environment handed to the child, so on any machine that pins
// ANTHROPIC_BASE_URL there (the normal setup behind cli-proxy-api, LiteLLM,
// or OpenRouter) the spawned CC ignored the MITM and billed a real request
// against the operator's subscription — ~21.5K cached + 3.2K input tokens on
// every proxy start, while cc-template.live.json was never written. The
// failure was invisible: capture reported "CC did not send a /v1/messages
// request", which is also what a machine with no CC installed reports.
//
// These assertions are about the SHAPE OF THE SPAWN, not about reaching the
// network, so they run offline and in CI.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'live-fingerprint.ts'), 'utf-8');

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
};

// Narrow to the spawn call so a match elsewhere in the file cannot satisfy these.
const spawnIdx = src.indexOf("spawn(claudeBin, ['--print', '-p', 'hi']");
check('capture still spawns the CC binary with a trivial prompt', spawnIdx > 0);

const spawnBlock = src.slice(Math.max(0, spawnIdx - 2600), spawnIdx + 900);

// The core guarantee: settings.json must not be in scope for the child.
check(
  'spawn relocates CLAUDE_CONFIG_DIR so settings.json cannot override the sandbox',
  /CLAUDE_CONFIG_DIR:\s*captureHome/.test(spawnBlock),
);
check(
  'the relocated config dir is a throwaway temp dir, not a repo path',
  /mkdtempSync\(join\(tmpdir\(\),\s*'dario-capture-'\)\)/.test(spawnBlock),
);

// A router proxy's token would route the child to that router instead of us.
check(
  'inherited ANTHROPIC_AUTH_TOKEN is dropped before spawning',
  /delete env\.ANTHROPIC_AUTH_TOKEN/.test(spawnBlock),
);

// Same sandbox defeat by a different route: either of these routes the child
// to Bedrock/Vertex, billing there with the identical "no request arrived".
check(
  'inherited CLAUDE_CODE_USE_BEDROCK is dropped before spawning',
  /delete env\.CLAUDE_CODE_USE_BEDROCK/.test(spawnBlock),
);
check(
  'inherited CLAUDE_CODE_USE_VERTEX is dropped before spawning',
  /delete env\.CLAUDE_CODE_USE_VERTEX/.test(spawnBlock),
);

// CLAUDE_CONFIG_DIR cannot relocate the machine-level policy file, whose env
// block outranks everything. Refuse the spend rather than rediscover the bug.
check(
  'capture bails when managed settings would override the sandbox',
  /export function managedSettingsBaseUrlOverride\(paths\?: string\[\]\)/.test(src)
  && /const managed = managedSettingsBaseUrlOverride\(\);/.test(src),
);
check(
  'the managed-settings bail is a distinct log line, not a silent null',
  /live capture skipped: \$\{managed\} sets env\.ANTHROPIC_BASE_URL/.test(src),
);
check(
  'the managed-settings path is checked per-platform',
  /ProgramData\\\\ClaudeCode\\\\managed-settings\.json/.test(src)
  && /\/etc\/claude-code\/managed-settings\.json/.test(src),
);

// Without an explicit cwd the child inherits the unit's WorkingDirectory,
// which dragged the operator's checkout (CLAUDE.md, git state) into a
// template meant to be generic.
check(
  'spawn pins cwd to the throwaway dir instead of inheriting the proxy cwd',
  /cwd:\s*captureHome/.test(spawnBlock),
);

// The MITM stays the only endpoint the child is pointed at.
check(
  'ANTHROPIC_BASE_URL is still pinned to the loopback MITM',
  /ANTHROPIC_BASE_URL:\s*url/.test(spawnBlock),
);
check(
  'the base-prompt model is still pinned',
  /ANTHROPIC_MODEL:\s*process\.env\.ANTHROPIC_MODEL\s*\?\?\s*TEMPLATE_BASE_MODEL/.test(spawnBlock),
);

// Cleanup — CC treats the config dir as its home and writes a session
// transcript into it. Leaving them behind is how the operator's
// ~/.claude/projects filled with junk `hi` sessions.
check(
  'the throwaway config dir is removed when the capture settles',
  /rmSync\(home,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\)/.test(src),
);

// CC keeps rebuilding its config skeleton for ~20s after SIGTERM, so any
// timed sweep loses. Kill uncatchably and sweep on the exit event instead.
check(
  'the capture child is SIGKILLed so it cannot write again',
  /child\?\.kill\('SIGKILL'\)/.test(src) && !/kill\('SIGTERM'\)/.test(src),
);
check(
  'cleanup is driven by the child exit event, not a timer race',
  /child\.once\('exit', sweep\)/.test(src),
);
check(
  'a backstop sweep exists and is unref\'d so it cannot delay shutdown',
  /setTimeout\(sweep, 30_000\)/.test(src) && /backstop\.unref\(\)/.test(src),
);

// The MITM must never become a forwarding proxy: it answers locally.
const mitmOk = /res\.writeHead\(200,\s*\{[\s\S]{0,200}text\/event-stream/.test(src)
  && !/fetch\(\s*['"`]https:\/\/api\.anthropic\.com/.test(src);
check('capture MITM answers locally and never forwards upstream', mitmOk);

// --- behavioural: the managed-settings guard, against real files ---
// Injectable paths so this never touches a real machine-level policy path.
const { managedSettingsBaseUrlOverride } = await import('../dist/live-fingerprint.js');
const tmp = mkdtempSync(join(tmpdir(), 'dario-managed-test-'));
const write = (name, obj) => {
  const p = join(tmp, name);
  writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return p;
};

check(
  'no managed file -> capture proceeds',
  managedSettingsBaseUrlOverride([join(tmp, 'does-not-exist.json')]) === null,
);
const hijack = write('hijack.json', { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721' } });
check(
  'managed file pinning ANTHROPIC_BASE_URL -> capture bails, and names the file',
  managedSettingsBaseUrlOverride([hijack]) === hijack,
);
check(
  'managed file WITHOUT a base-url override -> capture proceeds',
  managedSettingsBaseUrlOverride([write('other.json', { env: { FOO: 'bar' } })]) === null,
);
check(
  'managed file with an empty base url is not treated as an override',
  managedSettingsBaseUrlOverride([write('empty.json', { env: { ANTHROPIC_BASE_URL: '' } })]) === null,
);
check(
  'malformed managed file does not throw or block capture',
  managedSettingsBaseUrlOverride([write('bad.json', '{not json')]) === null,
);
check(
  'first matching path wins when several are checked',
  managedSettingsBaseUrlOverride([join(tmp, 'nope.json'), hijack]) === hijack,
);
rmSync(tmp, { recursive: true, force: true });

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);