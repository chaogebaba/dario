#!/usr/bin/env bun
// End-to-end capture, with a stand-in for the `claude` binary.
//
// Every other assertion about the capture path reads source text or calls one
// exported helper. Ten semantic mutations of this file's subject — dropping
// `env` from the spawn, deleting the managed-settings bail, making the temp-dir
// sweep unreachable, pointing the sandbox back at the operator's checkout —
// used to leave the suite fully green, because none of it ran the capture.
//
// `DARIO_CLAUDE_BIN` already existed as an override for non-standard installs.
// Pointed at a script instead of a binary, it turns the whole path into
// something a test can drive: dario starts its loopback MITM, spawns the stub,
// and the stub POSTs whatever body the scenario wants to whatever
// ANTHROPIC_BASE_URL it was actually given. What the stub receives is the
// child environment as the child really sees it — after the allowlist, after
// the pins, across a process boundary — and what dario writes afterwards is
// the acceptance gate's real verdict.
//
// The stub carries its scenario in its own source rather than in an env var,
// which is not a workaround but the point: the capture child's environment is
// an allowlist, so an env var invented by a test would be dropped exactly like
// the hijack variables it drops. A scenario that arrived would mean the
// allowlist had a hole.

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'dario-capture-e2e-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));

// Before the import: module init reads the cache path, and the operator's real
// one must be unreachable for the whole run.
process.env.DARIO_LIVE_TEMPLATE_CACHE = join(work, 'cc-template.live.json');

const { refreshLiveFingerprintAsync, _resetClaudeBinCacheForTest } =
  await import('../dist/live-fingerprint.js');

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`); }
}
function header(name) { console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`); }

const bundle = JSON.parse(readFileSync(join(here, '..', 'dist', 'cc-template-data.json'), 'utf-8'));

/** A request body in CC's shape, with the parts a scenario varies. */
function ccBody({ prompt = bundle.system_prompt, identity = bundle.agent_identity, tools } = {}) {
  return {
    model: 'claude-opus-4-8',
    max_tokens: 32,
    system: [
      { type: 'text', text: 'You are Claude Code, Anthropic’s official CLI for Claude.' },
      { type: 'text', text: identity, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: prompt, cache_control: { type: 'ephemeral' } },
    ],
    tools: tools ?? bundle.tools.slice(0, 12),
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
  };
}

/**
 * Write a stub `claude` and point dario at it. Returns the path the stub will
 * dump its own environment, argv and cwd to.
 */
function installStub(name, body) {
  const dump = join(work, `${name}.env.json`);
  const bin = join(work, `${name}.mjs`);
  writeFileSync(bin, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(dump)}, JSON.stringify({
  env: process.env, argv: process.argv.slice(2), cwd: process.cwd(),
}));
const base = process.env.ANTHROPIC_BASE_URL;
if (base) {
  try {
    const r = await fetch(base + '/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'claude-cli/2.1.236 (external, cli)',
        'x-app': 'cli',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'claude-code-20250219',
      },
      body: JSON.stringify(${JSON.stringify(body)}),
    });
    await r.text();
  } catch { /* the MITM may close first; the capture is already recorded */ }
}
`);
  chmodSync(bin, 0o755);
  process.env.DARIO_CLAUDE_BIN = bin;
  _resetClaudeBinCacheForTest();
  return dump;
}

/** One full refresh. Returns what dario returned and what it left on disk. */
async function refresh() {
  const cachePath = process.env.DARIO_LIVE_TEMPLATE_CACHE;
  rmSync(cachePath, { force: true });
  const before = new Set(readdirSync(tmpdir()).filter((d) => d.startsWith('dario-capture-')));
  const returned = await refreshLiveFingerprintAsync({ force: true, silent: true, timeoutMs: 15_000 });
  const written = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf-8')) : null;
  const after = readdirSync(tmpdir()).filter((d) => d.startsWith('dario-capture-') && !before.has(d));
  return { returned, written, strandedDirs: after };
}

// ======================================================================
header('a healthy capture is captured, accepted and written');
let healthyDump;
{
  healthyDump = installStub('healthy', ccBody());
  const { returned, written, strandedDirs } = await refresh();
  check('the refresh returns a template', returned !== null);
  check('and writes it to the cache', written !== null);
  check('the written prompt is the one the stub sent',
    written?.system_prompt === bundle.system_prompt);
  check('the written identity is the one the stub sent',
    written?.agent_identity === bundle.agent_identity);
  check('the CC version came off the stub\'s user-agent',
    written?._version === '2.1.236', String(written?._version));
  check('the tool list is what the stub advertised, not the bundle\'s',
    written?.tools.length === 12, `${written?.tools.length} tools`);

  // M7/M10: the sweep. The throwaway config dir is CC's HOME for the spawn,
  // and a proxy that leaks one per start accumulated nineteen on one machine.
  // Text assertions on `rmSync` and `child.once('exit', …)` cannot see this.
  check('the capture leaves no sandbox dir behind',
    strandedDirs.length === 0, strandedDirs.join(', '));
}

// ======================================================================
header('what the child actually received');
{
  const seen = JSON.parse(readFileSync(healthyDump, 'utf-8'));

  // M1: dropping `env` from the spawn options hands the child the parent's
  // environment whole. Asserted here across a real process boundary, on the
  // environment the child read for itself, rather than on the object the
  // parent built.
  check('the child was pointed at the loopback MITM, on a nonce path',
    /^http:\/\/127\.0\.0\.1:\d+\/dario-capture-[0-9a-f]{24}$/.test(seen.env.ANTHROPIC_BASE_URL ?? ''),
    seen.env.ANTHROPIC_BASE_URL);
  check('the child got the placeholder key, never the operator\'s',
    seen.env.ANTHROPIC_API_KEY === 'sk-dario-fingerprint-capture');
  check('the child got a throwaway CLAUDE_CONFIG_DIR', typeof seen.env.CLAUDE_CONFIG_DIR === 'string');

  // M9: pointing the sandbox at process.cwd() puts CC back in the operator's
  // checkout, which is what it read the gitStatus block out of.
  check('the sandbox is not the operator\'s checkout',
    seen.env.CLAUDE_CONFIG_DIR !== process.cwd() && !seen.env.CLAUDE_CONFIG_DIR.startsWith(here),
    seen.env.CLAUDE_CONFIG_DIR);
  check('and it is gone by the time the refresh returns', !existsSync(seen.env.CLAUDE_CONFIG_DIR));

  // The allowlist, measured at the far end rather than at the call site.
  const inherited = Object.keys(seen.env);
  const pinned = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'CLAUDE_CONFIG_DIR', 'CLAUDE_NONINTERACTIVE'];
  const unexpected = inherited.filter((k) => !pinned.includes(k) && !k.startsWith('LC_')
    && !['PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LANGUAGE', 'TZ', 'TERM'].includes(k));
  check(`the child's environment holds nothing outside the allowlist (extra: ${unexpected.join(', ') || 'none'})`,
    unexpected.length === 0);
  check('--print is on the argv, which is what keeps CC out of its OAuth flow',
    seen.argv.includes('--print'), seen.argv.join(' '));
}

// ======================================================================
header('a degenerate capture is refused, and nothing is written');
{
  // The gate's reason for existing: `tools` and the prompt variants are
  // repaired from the bundle at read time, but nothing repairs
  // `system_prompt`. A short one is served for the cache's whole 24h TTL with
  // no route back to the bundle short of deleting the file by hand.
  installStub('tiny', ccBody({ prompt: 'You are Claude.' }));
  const { returned, written } = await refresh();
  check('the refresh returns null', returned === null);
  check('and leaves no cache file at all', written === null,
    written ? `${written.system_prompt.length}B prompt written` : '');
}
{
  // The layout failure the floor cannot see: CC reshuffles its system blocks,
  // so block [2] is the identity rather than the prompt. Both fields stay
  // long and non-empty.
  installStub('shifted', ccBody({ prompt: bundle.agent_identity }));
  const { returned, written } = await refresh();
  check('a prompt that is really the identity block is refused', returned === null && written === null);
}
{
  installStub('alien', ccBody({ tools: [{ name: 'Zorp', description: 'x', input_schema: {} }] }));
  const { returned, written } = await refresh();
  check('a capture sharing no tool with the bundle is refused', returned === null && written === null);
}
{
  // And the negative control, so the three above are not passing because the
  // harness stopped capturing: the same machinery, one healthy body.
  installStub('healthy2', ccBody());
  const { returned, written } = await refresh();
  check('the harness still accepts a healthy capture afterwards',
    returned !== null && written !== null);
}

// ======================================================================
header('a child that never sends is not mistaken for a capture');
{
  const bin = join(work, 'silent.mjs');
  writeFileSync(bin, '#!/usr/bin/env node\nprocess.exit(0);\n');
  chmodSync(bin, 0o755);
  process.env.DARIO_CLAUDE_BIN = bin;
  _resetClaudeBinCacheForTest();
  const { returned, written, strandedDirs } = await refresh();
  check('the refresh returns null', returned === null && written === null);
  check('and still sweeps its sandbox dir', strandedDirs.length === 0, strandedDirs.join(', '));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
