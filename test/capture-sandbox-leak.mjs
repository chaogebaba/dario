// The memory section: a heading CC renamed, a guard that could not see the
// rename, and dario's own capture sandbox riding onto the wire.
//
// Measured against CC 2.1.239. Three defects, one section:
//
//  1. CC writes the memory section under TWO headings — `# auto memory` on the
//     long-form prompts (sonnet-5, haiku) and `# Memory` on the short-form ones
//     (base, fable, opus-5). HOST_CONTEXT_SECTION_HEADINGS listed only the
//     first, so every bake published the section for three of four families.
//     What kept a username out of the bundle was the path canonicalizer — the
//     last line of defense doing the section remover's job.
//
//  2. findUserPathHits claims in its own comment to catch "a renamed heading",
//     but it iterates the same list removeSection does. A rename is invisible
//     to the remover and to its guard at the same instant. Off a `$HOME`-rooted
//     config dir the identity rules miss too, so a shared runner would publish
//     its real config root and working-directory slug and the gate would pass.
//
//  3. The live-capture path runs no scrub at all, on purpose — environment-
//     block.ts needs real host context to rewrite. But the memory line sits
//     OUTSIDE `# Environment`, so nothing touched it, and the served prompt
//     pointed every model at `/tmp/dario-capture-XXXXXX/...`: a directory
//     deleted before the first request, named with a fresh nonce per capture,
//     under an instruction stating it definitely exists.

import { scrubTemplate, scrubText, findUserPathHits, stripCaptureSandboxPaths } from '../dist/scrub-template.js';

let pass = 0;
let fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}
function header(label) {
  console.log(`\n======================================================================`);
  console.log(`  ${label}`);
  console.log(`======================================================================`);
}

const CANONICAL = '/home/user/.claude/projects/project';
// CC words this two ways, one per prompt family. Both are exercised: the
// long-form wording is the one a detector pinned to the short sentence misses.
const memoryLine = (path) =>
  'You have a persistent file-based memory at `' + path + '`. This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).';
const memoryLineLongForm = (path) =>
  'You have a persistent, file-based memory system at `' + path + '`. This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).';

// The shape CC emits inside the capture sandbox, verbatim down to the slug
// convention (the config dir's own absolute path with separators turned to `-`).
const SANDBOX = '/tmp/dario-capture-X9XR4g/projects/-tmp-dario-capture-X9XR4g/memory/';

header('1. the capture sandbox never reaches a served prompt');
{
  const out = stripCaptureSandboxPaths(memoryLine(SANDBOX));
  check('the sandbox path is replaced', !out.includes('dario-capture'));
  check('replaced with the canonical placeholder', out.includes(`${CANONICAL}/memory/`));
  check('the trailing slash survives', out.includes('memory/`'));
  check('the surrounding prose is untouched', out.includes('This directory already exists'));
  check('idempotent', stripCaptureSandboxPaths(out) === out);

  // Each variant is captured in its OWN sandbox, so a single nonce is not
  // enough: the base and every variant carry a different one.
  const two = stripCaptureSandboxPaths(
    `${memoryLine(SANDBOX)}\n${memoryLine('/tmp/dario-capture-PbrXvv/projects/-tmp-dario-capture-PbrXvv/memory/')}`,
  );
  check('every distinct nonce is stripped, not just the first', !/dario-capture/.test(two));

  // The narrow scope is the point: this runs on the LIVE path, which keeps host
  // context deliberately so environment-block.ts has a shape to rewrite.
  const host = 'Primary working directory: /home/chao/VScode_projects/dario';
  check('a real host path is left alone', stripCaptureSandboxPaths(host) === host);
}

header('2. both spellings of the memory heading are stripped by a bake');
{
  const withSection = (heading, path) =>
    `# Harness\nsome prose\n\n# ${heading}\n\n${memoryLine(path)}\n\n# Context management\ntail prose`;

  for (const heading of ['auto memory', 'Memory']) {
    const t = {
      _version: '2.1.239',
      _captured: '2026-08-21T23:42:37.396Z',
      _source: 'live',
      agent_identity: 'You are Claude Code',
      system_prompt: withSection(heading, '/home/chao/.claude/projects/-home-chao-work/memory/'),
      tools: [],
      tool_names: [],
    };
    const s = scrubTemplate(t);
    check(`\`# ${heading}\` is removed from a baked prompt`, !s.system_prompt.includes(`# ${heading}`));
    check(`\`# ${heading}\` takes its memory path with it`, !s.system_prompt.includes('memory/'));
    check(`\`# ${heading}\` removal keeps the sections around it`, s.system_prompt.includes('# Harness') && s.system_prompt.includes('# Context management'));
  }
}

header('3. the gate does not derive from the list it guards');
{
  // The exact escape: CLAUDE_CONFIG_DIR off `$HOME` on a shared runner. No
  // `/home/<user>`, no `/Users/<user>`, no `/.claude/projects/` — every
  // identity rule misses, and the section-heading loop cannot help because the
  // leak is the PATH, not the heading.
  const offHome = '/srv/shared/cc-config/projects/-srv-acme-billing-service/memory/';
  const leaked = memoryLine(offHome);
  check('scrubText alone does not canonicalize an off-home config dir', scrubText(leaked).includes(offHome));
  const hits = findUserPathHits(leaked);
  check('findUserPathHits flags it anyway', hits.length > 0);
  check('the hit names the path', hits.some((h) => h.includes('/srv/shared/cc-config')));
  check('the hit says why', hits.some((h) => h.includes('memory path not canonicalized')));

  // Both wordings, since the two prompt families do not share one.
  check('the long-form wording is flagged too', findUserPathHits(memoryLineLongForm(offHome)).length > 0);
  check('the long-form canonical form is not a hit', findUserPathHits(memoryLineLongForm(`${CANONICAL}/memory/`)).length === 0);

  // And it must fire on a heading nobody has listed yet — the whole point of
  // keying on prose. This is the next rename, pre-registered.
  const renamed = `# Harness\nprose\n\n# Persistent Notes\n\n${memoryLine(offHome)}\n`;
  check('a heading no list knows about still trips the gate', findUserPathHits(renamed).length > 0);

  // Symmetry: the canonical form is what a clean bundle carries, and must not
  // be reported. A gate that cries on its own output gets switched off.
  check('the canonical placeholder is not a hit', findUserPathHits(memoryLine(`${CANONICAL}/memory/`)).length === 0);
  check('a prompt with no memory section is not a hit', findUserPathHits('# Harness\nprose only\n').length === 0);

  // The sandbox path is a leak too, and must fail a bake rather than be
  // quietly canonicalized into looking clean.
  check('the capture sandbox is a hit before it is stripped', findUserPathHits(memoryLine(SANDBOX)).length > 0);
}

header('4. the shipped bundle carries no memory path');
{
  const bundle = JSON.parse(
    await (await import('node:fs/promises')).readFile(new URL('../src/cc-template-data.json', import.meta.url), 'utf-8'),
  );
  const prompts = [bundle.system_prompt, ...Object.values(bundle.system_prompt_variants ?? {})];
  if (typeof bundle.system_prompt_fable === 'string') prompts.push(bundle.system_prompt_fable);
  // The bundle predates the fix and is rebaked by the cc-drift bot, not by
  // hand, so it may still carry the section — but never a live host path and
  // never a sandbox nonce. Those two are unconditional.
  check('no bundled prompt carries a capture-sandbox nonce', prompts.every((p) => !/dario-capture/.test(p)));
  check('no bundled prompt trips the user-path gate', prompts.every((p) => findUserPathHits(p).length === 0));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
