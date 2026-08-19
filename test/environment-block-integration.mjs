// 9c, end to end: what `resolveSystemPrompt` actually hands each model when a
// live capture is present.
//
// The unit suite (environment-block.mjs) covers the rewrite in isolation. This
// one drives the production seam with a synthetic live cache, because the two
// halves of the bug live at opposite ends of that seam: the captured base
// carries a sandbox environment that gets replayed to every model, and the
// bundled variants carry none at all because the bake scrubs host context
// before publishing.
//
// The cache path is redirected BEFORE the dynamic import — cc-template.js
// reads the template at module init, and pointed at the real path this would
// serve the operator's own dario a fake prompt.

import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}
function header(label) {
  console.log(`\n======================================================================`);
  console.log(`  ${label}`);
  console.log(`======================================================================`);
}

const DIR = join(tmpdir(), `dario-env-block-test-${process.pid}`);
mkdirSync(DIR, { recursive: true });
const CACHE = join(DIR, 'cc-template.live.json');
process.env.DARIO_LIVE_TEMPLATE_CACHE = CACHE;
process.on('exit', () => { try { rmSync(DIR, { recursive: true, force: true }); } catch { /* noop */ } });

const CAPTURED_BLOCK = [
  '# Environment',
  'You have been invoked in the following environment: ',
  ' - Primary working directory: /tmp/dario-capture-cGZjcC',
  ' - Is a git repository: false',
  ' - Platform: linux',
  ' - Shell: zsh',
  ' - OS Version: Linux 7.1.8-200.fc44.x86_64',
  ' - You are powered by the model named Opus 4.8. The exact model ID is claude-opus-4-8.',
  ' - Assistant knowledge cutoff is January 2026.',
  " - The most recent Claude models are the Claude 5 family and Haiku 4.5.",
].join('\n');

// Build a valid live cache off the bundled template so loadTemplate's own
// shape rules are satisfied, then plant the capture's environment block in the
// base exactly where CC puts it and leave the variants without one — the state
// this machine was actually in.
const bundled = JSON.parse(readFileSync(new URL('../dist/cc-template-data.json', import.meta.url), 'utf-8'));
const base = `# Memory\nremember things\n\n${CAPTURED_BLOCK}\n\n# Context management\nlong conversations\n`;
writeFileSync(CACHE, JSON.stringify({
  ...bundled,
  _captured: new Date().toISOString(),
  system_prompt: base,
  system_prompt_variants: {
    'opus-5': '# Harness\nstuff\n\n# Context management\nlong conversations\n\n# Delivering work\nship it\n',
    'sonnet-5': '# System\nstuff\n\n# Context management\nlong conversations\n',
    fable: '# Harness\nstuff\n\n# Context management\nlong conversations\n',
  },
}));

const { resolveSystemPrompt } = await import('../dist/cc-template.js');

function envOf(prompt) {
  const i = prompt.indexOf('# Environment');
  if (i < 0) return null;
  const j = prompt.indexOf('\n# ', i + 1);
  return prompt.slice(i, j < 0 ? prompt.length : j);
}

// ======================================================================
header('every model gets an environment section, and it is this machine');
for (const [model, name] of [
  ['claude-opus-4-8', 'Opus 4.8'],
  ['claude-opus-5', 'Opus 5'],
  ['claude-sonnet-5', 'Sonnet 5'],
  ['claude-fable-5', 'Fable 5'],
  ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
]) {
  const block = envOf(resolveSystemPrompt(undefined, model));
  check(`${model}: has an # Environment section`, block !== null);
  check(`${model}: named as ${name}`, Boolean(block?.includes(`the model named ${name}.`)));
  check(`${model}: the capture sandbox is gone`, !block?.includes('/tmp/dario-capture-'));
  check(`${model}: the cwd is the running process's`,
    Boolean(block?.includes(` - Primary working directory: ${process.cwd()}`)));
  check(`${model}: git is answered for that cwd`, Boolean(block?.includes(' - Is a git repository: true')));
}

// ======================================================================
header('the cutoff belongs to the model it was captured under, and no other');
{
  check('the captured model keeps it',
    Boolean(envOf(resolveSystemPrompt(undefined, 'claude-opus-4-8'))?.includes('knowledge cutoff is January 2026')));
  for (const model of ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']) {
    // A missing section is not a pass here — it is the other half of the bug.
    const block = envOf(resolveSystemPrompt(undefined, model));
    check(`${model} does not borrow it`, block !== null && !block.includes('knowledge cutoff'));
  }
}

// ======================================================================
header('the section lands where CC puts it, once');
for (const model of ['claude-opus-4-8', 'claude-opus-5', 'claude-sonnet-5']) {
  const prompt = resolveSystemPrompt(undefined, model);
  check(`${model}: exactly one section`, (prompt.match(/# Environment\n/g) || []).length === 1);
  check(`${model}: immediately before # Context management`,
    prompt.indexOf('# Environment') < prompt.indexOf('# Context management'));
  check(`${model}: the variant's own sections survive`, prompt.includes('# Context management\nlong conversations'));
}
check('the opus-5 variant keeps its trailing sections',
  resolveSystemPrompt(undefined, 'claude-opus-5').includes('# Delivering work\nship it'));

// ======================================================================
header('the strip levels compose with it rather than dropping it');
for (const level of ['verbatim', 'partial', 'aggressive']) {
  const block = envOf(resolveSystemPrompt(level, 'claude-sonnet-5'));
  check(`--system-prompt=${level} keeps the section`, block !== null);
  check(`--system-prompt=${level} still names Sonnet 5`, Boolean(block?.includes('the model named Sonnet 5.')));
}

// ======================================================================
header('an operator-supplied prompt is left entirely alone');
{
  const custom = 'just do what I say';
  check('a custom system prompt gets no environment section',
    resolveSystemPrompt(custom, 'claude-opus-5') === custom);
}

// ======================================================================
header('repeated resolution is stable — the memo must not drift per call');
{
  const a = resolveSystemPrompt(undefined, 'claude-sonnet-5');
  const b = resolveSystemPrompt(undefined, 'claude-sonnet-5');
  check('two calls agree byte for byte', a === b);
  check('and a different model does not get the first one\'s block',
    resolveSystemPrompt(undefined, 'claude-fable-5').includes('the model named Fable 5.'));
}

console.log(`\n${'='.repeat(70)}\n  ${pass} pass, ${fail} fail\n${'='.repeat(70)}`);
process.exit(fail === 0 ? 0 : 1);
