// 9c — the base prompt carried the capture sandbox's environment.
//
// A live capture runs `claude` in a throwaway config home, so the block it
// records says the working directory is `/tmp/dario-capture-XXXXXX`, that git
// is unavailable, and that the model is whatever the capture ran under. dario
// then replayed that to every request: a haiku call was told it was Opus 4.8,
// in a directory that stopped existing when the capture ended. The bundled
// prompt variants had the opposite problem — the bake scrubs host context
// before publishing, so an opus-5 request got no `# Environment` at all, where
// real CC always sends one.
//
// The rule under test is REWRITE, NEVER INVENT: host and model lines are
// replaced from facts read off the running system, and every line CC authored
// passes through untouched. A line that cannot be sourced for the served model
// is dropped rather than restated.

import {
  applyEnvironmentSection,
  capturedModelId,
  detectEnvironmentFacts,
  extractEnvironmentSection,
  isInsideGitRepo,
  modelDisplayName,
  rewriteEnvironmentBlock,
  sameModel,
  spliceEnvironmentSection,
} from '../dist/environment-block.js';
import { mkdtempSync, rmSync } from 'node:fs';
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

// The block exactly as the audit machine's capture recorded it.
const CAPTURED = [
  '# Environment',
  'You have been invoked in the following environment: ',
  ' - Primary working directory: /tmp/dario-capture-cGZjcC',
  ' - Is a git repository: false',
  ' - Platform: linux',
  ' - Shell: zsh',
  ' - OS Version: Linux 7.1.8-200.fc44.x86_64',
  ' - You are powered by the model named Opus 4.8. The exact model ID is claude-opus-4-8.',
  ' - Assistant knowledge cutoff is January 2026.',
  " - The most recent Claude models are the Claude 5 family and Haiku 4.5. Model IDs — Fable 5: 'claude-fable-5'.",
  ' - Claude Code is available as a CLI in the terminal, desktop app (Mac/Windows), web app (claude.ai/code).',
  ' - Fast mode for Claude Code uses Claude Opus with faster output. It can be toggled with /fast.',
].join('\n');

const HOST = { cwd: '/home/dev/project', env: { SHELL: '/usr/bin/fish' } };

// ======================================================================
header('CC display names, and the ids that have none');
{
  check('claude-opus-4-8 → Opus 4.8', modelDisplayName('claude-opus-4-8') === 'Opus 4.8');
  check('claude-opus-5 → Opus 5', modelDisplayName('claude-opus-5') === 'Opus 5');
  check('the [1m] suffix becomes CC\'s "(1M context)"',
    modelDisplayName('claude-opus-5[1m]') === 'Opus 5 (1M context)');
  check('a release date is not part of the name',
    modelDisplayName('claude-haiku-4-5-20251001') === 'Haiku 4.5');
  check('claude-sonnet-5 → Sonnet 5', modelDisplayName('claude-sonnet-5') === 'Sonnet 5');
  check('claude-fable-5 → Fable 5', modelDisplayName('claude-fable-5') === 'Fable 5');
  check('a provider prefix is stripped',
    modelDisplayName('anthropic/claude-opus-5') === 'Opus 5');
  // Generic over the family word, so a family that does not exist yet still
  // parses rather than silently dropping the line CC always sends.
  check('an unreleased family still parses', modelDisplayName('claude-quartz-7-2') === 'Quartz 7.2');
  check('the pre-family id shape has no name', modelDisplayName('claude-3-5-sonnet-20241022') === null);
  check('a non-Claude id has no name', modelDisplayName('gpt-4o') === null);
  check('the empty id has no name', modelDisplayName('') === null);
}

// ======================================================================
header('the cutoff line survives only for the model it was captured under');
{
  check('same id', sameModel('claude-opus-4-8', 'claude-opus-4-8'));
  check('the [1m] variant is the same model', sameModel('claude-opus-5', 'claude-opus-5[1m]'));
  check('the dated id is the same model', sameModel('claude-haiku-4-5', 'claude-haiku-4-5-20251001'));
  check('a different family is not', !sameModel('claude-opus-4-8', 'claude-sonnet-5'));
  check('a different version is not', !sameModel('claude-opus-4-8', 'claude-opus-5'));
  check('empty matches nothing', !sameModel('', ''));
  check('the captured id is read off the block', capturedModelId(CAPTURED) === 'claude-opus-4-8');
  check('a block with no model line names nothing', capturedModelId('# Environment\n - Platform: linux') === null);
}

// ======================================================================
header('the rewrite replaces host lines and leaves CC\'s prose alone');
{
  const facts = detectEnvironmentFacts('claude-opus-4-8', HOST);
  const out = rewriteEnvironmentBlock(CAPTURED, facts, true);
  const line = (prefix) => out.split('\n').find((l) => l.startsWith(prefix));

  check('the capture sandbox is gone', !out.includes('/tmp/dario-capture-'));
  check('the real cwd is written', line(' - Primary working directory: ') === ' - Primary working directory: /home/dev/project');
  check('the git flag is answered for that cwd', line(' - Is a git repository: ') === ` - Is a git repository: ${facts.isGitRepo}`);
  check('the shell comes from the environment', line(' - Shell: ') === ' - Shell: fish');
  check('the OS line is the running kernel', line(' - OS Version: ') === ` - OS Version: ${facts.osVersion}`);

  // Everything CC authored has to survive verbatim — dario has no source for
  // this prose other than the binary that produced it.
  check('the model-catalog line is untouched', out.includes("Model IDs — Fable 5: 'claude-fable-5'."));
  check('the CC-availability line is untouched', out.includes('desktop app (Mac/Windows), web app (claude.ai/code)'));
  check('the fast-mode line is untouched', out.includes('It can be toggled with /fast.'));
  check('the preamble is untouched', out.includes('You have been invoked in the following environment: '));
  check('the heading is kept', out.startsWith('# Environment\n'));
  check('no line was added or lost', out.split('\n').length === CAPTURED.split('\n').length);
}

// ======================================================================
header('an unsourceable shell leaves the captured line rather than guessing');
{
  const facts = detectEnvironmentFacts('claude-opus-4-8', { cwd: '/home/dev/project', env: {} });
  const out = rewriteEnvironmentBlock(CAPTURED, facts, true);
  check('SHELL unset keeps the captured shell line', out.includes(' - Shell: zsh'));
}

// ======================================================================
header('the two model-specific lines');
{
  const served = detectEnvironmentFacts('claude-sonnet-5', HOST);
  const out = rewriteEnvironmentBlock(CAPTURED, served, false);
  check('the model line names the served model',
    out.includes(' - You are powered by the model named Sonnet 5. The exact model ID is claude-sonnet-5.'));
  check('and no longer names the captured one', !out.includes('Opus 4.8'));
  // Restating January 2026 to a model whose real answer is different is the
  // same fabrication this module exists to remove.
  check('the cutoff captured under another model is dropped', !out.includes('knowledge cutoff'));

  const same = rewriteEnvironmentBlock(CAPTURED, detectEnvironmentFacts('claude-opus-4-8', HOST), true);
  check('and kept for the model it was captured under', same.includes(' - Assistant knowledge cutoff is January 2026.'));

  const unknown = rewriteEnvironmentBlock(CAPTURED, detectEnvironmentFacts('gpt-4o', HOST), false);
  check('an id with no name drops the model line rather than keeping a false one',
    !unknown.includes('You are powered by the model named'));
  check('and the rest of the block is still there', unknown.includes(' - Platform: '));
}

// ======================================================================
header('the wire id goes on the wire, suffixes included');
{
  const out = rewriteEnvironmentBlock(CAPTURED, detectEnvironmentFacts('claude-opus-5[1m]', HOST), false);
  check('name carries the context note',
    out.includes('the model named Opus 5 (1M context).'));
  check('id is the one actually sent', out.includes('The exact model ID is claude-opus-5[1m].'));
}

// ======================================================================
header('extraction and splicing follow CC\'s own section boundaries');
{
  const prompt = `# Memory\nremember things\n\n${CAPTURED}\n\n# Context management\nlong conversations\n`;
  const got = extractEnvironmentSection(prompt);
  check('the section is found', got !== null);
  check('it stops at the next top-level heading', !got.includes('# Context management'));
  check('and carries no trailing blank line', got.endsWith('/fast.'));
  check('a prompt without one extracts null', extractEnvironmentSection('# Memory\nx\n') === null);

  const replaced = spliceEnvironmentSection(prompt, '# Environment\n - Platform: sunos');
  check('an existing section is replaced, not duplicated',
    (replaced.match(/# Environment/g) || []).length === 1);
  check('the replacement is the new text', replaced.includes(' - Platform: sunos'));
  check('the sandbox path is gone', !replaced.includes('/tmp/dario-capture-'));
  check('the neighbouring sections survive',
    replaced.includes('# Memory\nremember things') && replaced.includes('# Context management\nlong conversations'));

  // CC puts `# Environment` immediately before `# Context management` —
  // confirmed on two independently produced prompts.
  const variant = '# Memory\nremember things\n\n# Context management\nlong conversations\n';
  const inserted = spliceEnvironmentSection(variant, '# Environment\n - Platform: linux');
  check('a variant with no section gets one', inserted.includes('# Environment'));
  check('inserted immediately before # Context management',
    inserted.indexOf('# Environment') < inserted.indexOf('# Context management'));
  check('and after # Memory', inserted.indexOf('# Memory') < inserted.indexOf('# Environment'));

  const noAnchor = '# Memory\nremember things\n';
  const appended = spliceEnvironmentSection(noAnchor, '# Environment\n - Platform: linux');
  check('with no anchor the block goes last', appended.trimEnd().endsWith(' - Platform: linux'));
}

// ======================================================================
header('with no capture there is nothing to model, and nothing is invented');
{
  const prompt = '# Memory\nremember things\n\n# Context management\nlong conversations\n';
  check('a bundle-only install is returned untouched',
    applyEnvironmentSection(prompt, null, 'claude-opus-5') === prompt);
}

// ======================================================================
header('end to end through applyEnvironmentSection');
{
  const variant = '# Memory\nremember things\n\n# Context management\nlong conversations\n';
  const out = applyEnvironmentSection(variant, CAPTURED, 'claude-sonnet-5', HOST);
  check('the variant now carries an environment section', out.includes('# Environment'));
  check('naming the served model', out.includes('the model named Sonnet 5.'));
  check('describing the real host', out.includes(' - Primary working directory: /home/dev/project'));
  check('with no capture sandbox anywhere', !out.includes('/tmp/dario-capture-'));
  check('and no cutoff borrowed from another model', !out.includes('knowledge cutoff'));
}

// ======================================================================
header('the git probe walks up, as a worktree or a subdirectory needs');
{
  check('this repo is detected from a nested path', isInsideGitRepo(`${process.cwd()}/src`));
  check('and the root itself', isInsideGitRepo(process.cwd()));

  // A directory with no `.git` anywhere above it must answer false, or the
  // rewritten line claims a repo the model does not have.
  const outside = mkdtempSync(join(tmpdir(), 'dario-env-nogit-'));
  try {
    check('a temp dir under no repo is not one', isInsideGitRepo(outside) === false);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
}

console.log(`\n${'='.repeat(70)}\n  ${pass} pass, ${fail} fail\n${'='.repeat(70)}`);
process.exit(fail === 0 ? 0 : 1);
