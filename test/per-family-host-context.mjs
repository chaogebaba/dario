// What each model is actually served once the live capture records a prompt
// PER FAMILY rather than one prompt on the base model.
//
// Before the sweep, a runtime refresh captured once, under opus-4-8, and wrote
// a cache with no variants at all; `withBundledFallbacks` then filled them from
// the bundle, whose variants are scrubbed of host context and as old as the
// last bake. Two consequences this suite pins:
//
//   1. A variant captured under its own model carries its own knowledge
//      cutoff, so the request path keeps the line instead of dropping it. The
//      values below are measured, not invented — CC 2.1.236 answers May 2026
//      for opus-5, January 2026 for sonnet-5, February 2025 for haiku.
//   2. The `gitStatus:` block reaches every one of them, rewritten from the
//      serving host rather than from the capture sandbox's throwaway repo.
//
// The cache path is redirected BEFORE the dynamic import: cc-template.js reads
// the template at module init.

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

const DIR = join(tmpdir(), `dario-per-family-test-${process.pid}`);
mkdirSync(DIR, { recursive: true });
const CACHE = join(DIR, 'cc-template.live.json');
process.env.DARIO_LIVE_TEMPLATE_CACHE = CACHE;
process.on('exit', () => { try { rmSync(DIR, { recursive: true, force: true }); } catch { /* noop */ } });

// The sandbox shape a capture actually produces, now that the sandbox is a git
// repo: a `/tmp` cwd, git true, and the seeded repo's own clean status.
function capturedPrompt(modelName, modelId, cutoff) {
  return [
    '# Memory',
    'remember things',
    '',
    '# Environment',
    'You have been invoked in the following environment: ',
    ' - Primary working directory: /tmp/dario-capture-uLS5eU',
    ' - Is a git repository: true',
    ' - Platform: linux',
    ' - Shell: zsh',
    ' - OS Version: Linux 7.1.8-200.fc44.x86_64',
    ` - You are powered by the model named ${modelName}. The exact model ID is ${modelId}.`,
    ` - Assistant knowledge cutoff is ${cutoff}.`,
    ' - Claude Code is available as a CLI in the terminal.',
    '',
    '# Context management',
    'long conversations',
    '',
    'gitStatus: This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.',
    '',
    'Current branch: main',
    '',
    'Main branch (you will usually use this for PRs): main',
    '',
    'Git user: dario',
    '',
    'Status:',
    '(clean)',
    '',
    'Recent commits:',
    '5ef53df capture sandbox',
  ].join('\n');
}

const bundled = JSON.parse(readFileSync(new URL('../dist/cc-template-data.json', import.meta.url), 'utf-8'));
writeFileSync(CACHE, JSON.stringify({
  ...bundled,
  _captured: new Date().toISOString(),
  system_prompt: capturedPrompt('Opus 4.8', 'claude-opus-4-8', 'January 2026'),
  system_prompt_variants: {
    'opus-5': capturedPrompt('Opus 5', 'claude-opus-5', 'May 2026'),
    'sonnet-5': capturedPrompt('Sonnet 5', 'claude-sonnet-5', 'January 2026'),
    'haiku': capturedPrompt('Haiku 4.5', 'claude-haiku-4-5-20251001', 'February 2025'),
    // Left out on purpose: a family whose capture failed still falls back to
    // the bundle, which carries no host context at all.
  },
}));

const { resolveSystemPrompt } = await import('../dist/cc-template.js');
const { detectGitStatusFacts, extractEnvironmentSection, extractGitStatusBlock } =
  await import('../dist/environment-block.js');

const HOST_GIT = detectGitStatusFacts(process.cwd());
const envOf = (m) => extractEnvironmentSection(resolveSystemPrompt(undefined, m));
const gitOf = (m) => extractGitStatusBlock(resolveSystemPrompt(undefined, m));

// ─────────────────────────────────────────────────────────────
header('each family keeps the cutoff it was captured under');
{
  const cases = [
    ['claude-opus-5', 'Opus 5', 'May 2026'],
    ['claude-sonnet-5', 'Sonnet 5', 'January 2026'],
    ['claude-haiku-4-5-20251001', 'Haiku 4.5', 'February 2025'],
    ['claude-opus-4-8', 'Opus 4.8', 'January 2026'],
  ];
  for (const [id, name, cutoff] of cases) {
    const block = envOf(id);
    check(`${id}: named as ${name}`,
      block !== null && block.includes(`the model named ${name}. The exact model ID is ${id}.`));
    check(`${id}: keeps its own cutoff (${cutoff})`,
      block !== null && block.includes(`Assistant knowledge cutoff is ${cutoff}.`));
    check(`${id}: carries exactly one cutoff line`,
      (block ?? '').split('Assistant knowledge cutoff').length - 1 === 1);
  }
  // The whole point of the sweep: before it, three of the four could only be
  // served the base's January 2026 or have the line dropped entirely.
  check('opus-5 is not handed the base model\'s cutoff',
    !(envOf('claude-opus-5') ?? '').includes('January 2026'));
  check('haiku is not handed the base model\'s cutoff',
    !(envOf('claude-haiku-4-5-20251001') ?? '').includes('January 2026'));
}

// ─────────────────────────────────────────────────────────────
header('a model no family covers still gets the base, with the line dropped');
{
  const block = envOf('claude-3-5-sonnet-20241022');
  check('an id CC does not name keeps no model line',
    block !== null && !block.includes('You are powered by the model named'));
  check('...and no cutoff borrowed from the captured model',
    block !== null && !block.includes('Assistant knowledge cutoff'));
  check('...while every host line is still the real one',
    block !== null && block.includes(` - Primary working directory: ${process.cwd()}`));
}

// ─────────────────────────────────────────────────────────────
header('gitStatus reaches every model, describing the serving host');
{
  for (const id of ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-8']) {
    const g = gitOf(id);
    if (HOST_GIT) {
      check(`${id}: gitStatus names the serving repo's branch`,
        g !== null && g.includes(`Current branch: ${HOST_GIT.branch}`));
      check(`${id}: gitStatus names the serving repo's user, or omits it where none is set`,
        g !== null && (HOST_GIT.user
          ? g.includes(`Git user: ${HOST_GIT.user}`)
          : !g.includes('Git user:')));
      check(`${id}: the capture sandbox's own commit is gone`,
        g !== null && !g.includes('5ef53df capture sandbox'));
    } else {
      check(`${id}: no repo to describe, so no block`, g === null);
    }
  }
  // Guarded, like the loop above: run from a directory that is not a
  // repository — a packaged install, a mutation tree — there is correctly no
  // block to inspect.
  if (HOST_GIT) {
    check('the preamble CC wrote is passed through verbatim',
      (gitOf('claude-opus-5') ?? '').startsWith(
        'gitStatus: This is the git status at the start of the conversation.'));
  }
  const whole = resolveSystemPrompt(undefined, 'claude-opus-5');
  check('exactly one gitStatus block', whole.split('\ngitStatus:').length - 1 === (HOST_GIT ? 1 : 0));
  check('it sits after the last heading, as CC appends it',
    !HOST_GIT || whole.indexOf('\ngitStatus:') > whole.lastIndexOf('\n# '));
}

// ─────────────────────────────────────────────────────────────
header('a family with no captured variant falls back without inventing one');
{
  // fable is absent from the cache above, so it resolves through the bundle —
  // scrubbed, therefore carrying no host context of its own. It must still be
  // given this host's environment, modelled on the base's captured block.
  const block = envOf('claude-fable-5');
  check('fable still gets an environment section', block !== null);
  check('...describing this host', (block ?? '').includes(` - Primary working directory: ${process.cwd()}`));
  check('...naming fable, not the captured model',
    (block ?? '').includes('the model named Fable 5. The exact model ID is claude-fable-5.'));
  check('...with no cutoff, because none was captured under fable',
    !(block ?? '').includes('Assistant knowledge cutoff'));
}

// ─────────────────────────────────────────────────────────────
header('the sandbox never reaches the wire');
{
  for (const id of ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-fable-5', 'claude-opus-4-8']) {
    const p = resolveSystemPrompt(undefined, id);
    check(`${id}: no capture sandbox path`, !p.includes('/tmp/dario-capture-'));
    check(`${id}: no capture sandbox git identity`, !p.includes('Git user: dario\n'));
  }
}

// ─────────────────────────────────────────────────────────────
header('memoization is stable');
{
  check('two resolves are identical',
    resolveSystemPrompt(undefined, 'claude-opus-5') === resolveSystemPrompt(undefined, 'claude-opus-5'));
  check('different models resolve differently',
    resolveSystemPrompt(undefined, 'claude-opus-5') !== resolveSystemPrompt(undefined, 'claude-sonnet-5'));
  check('a custom prompt is left entirely alone',
    resolveSystemPrompt('my own text', 'claude-opus-5') === 'my own text');
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
