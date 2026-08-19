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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
