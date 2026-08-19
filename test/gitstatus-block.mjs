// CC's `gitStatus:` block, rewritten from the serving host's own repository.
//
// The shape under test was measured, not assumed: five captures against CC
// 2.1.236 in a scratch repo established that CC appends the block after the
// last heading, renders a clean tree as the literal `(clean)`, lists exactly
// five commits, names `main` as the PR target when the repo has one and
// `master` when it has only that — and names `main` even on a repo that has
// neither. Each of those is pinned below, because each of them is a fact about
// CC that a future build could change under us.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyGitStatusBlock,
  detectGitStatusFacts,
  extractGitStatusBlock,
  rewriteGitStatusBlock,
  spliceGitStatusBlock,
} from '../dist/environment-block.js';
import { _seedCaptureRepoForTest } from '../dist/live-fingerprint.js';

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

const TMP = [];
function scratchRepo(build) {
  const dir = mkdtempSync(join(tmpdir(), 'dario-gitstatus-test-'));
  TMP.push(dir);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { env, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'probe-user');
  git('config', 'user.email', 'p@x.invalid');
  git('config', 'commit.gpgsign', 'false');
  build(git, dir);
  return dir;
}
process.on('exit', () => {
  for (const d of TMP) { try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
});

// The block exactly as CC 2.1.236 emitted it into the capture sandbox.
const CAPTURED = [
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

const FACTS = {
  branch: 'master',
  mainBranch: 'master',
  user: 'chaogebaba',
  status: ' M src/pool.ts\n?? notes.md',
  recentCommits: 'c07631f docs\na7ec133 fix',
};

// ─────────────────────────────────────────────────────────────
header('rewrite — every host value is substituted, every CC word survives');
{
  const out = rewriteGitStatusBlock(CAPTURED, FACTS);
  check('the preamble sentence is byte-identical', out.split('\n')[0] === CAPTURED.split('\n')[0]);
  check('branch replaced', out.includes('\nCurrent branch: master\n'));
  check('main branch replaced inside CC\'s own label',
    out.includes('\nMain branch (you will usually use this for PRs): master\n'));
  check('git user replaced', out.includes('\nGit user: chaogebaba\n'));
  check('status body replaced', out.includes('Status:\n M src/pool.ts\n?? notes.md'));
  check('the captured "(clean)" is gone once there is a real status', !out.includes('(clean)'));
  check('commits replaced', out.includes('Recent commits:\nc07631f docs\na7ec133 fix'));
  check('the capture\'s own commit is gone', !out.includes('5ef53df'));
  check('no section gained or lost',
    out.split('\n\n').length === CAPTURED.split('\n\n').length);

  // The leading column of `git status --porcelain` is load-bearing: " M" is an
  // unstaged edit, "M " a staged one. A trim on the whole body eats it off the
  // first line only, which is how this was caught.
  check('the porcelain status column survives on the first line',
    out.includes('Status:\n M src/pool.ts'));
}

// ─────────────────────────────────────────────────────────────
header('rewrite — the two empty cases resolve opposite ways');
{
  const clean = rewriteGitStatusBlock(CAPTURED, { ...FACTS, status: '' });
  check('a clean tree keeps CC\'s own rendering of one', clean.includes('Status:\n(clean)'));
  check('...and still takes the other substitutions', clean.includes('Git user: chaogebaba'));

  const noCommits = rewriteGitStatusBlock(CAPTURED, { ...FACTS, recentCommits: '' });
  check('an empty log drops the section rather than restating the capture\'s commits',
    !noCommits.includes('Recent commits:'));
  check('...and does not leave the capture\'s sha behind', !noCommits.includes('5ef53df'));
  check('dropping one section leaves the rest intact',
    noCommits.includes('Status:') && noCommits.includes('Current branch: master'));
}

// ─────────────────────────────────────────────────────────────
header('rewrite — an unset git identity costs one section, not the block');
{
  const out = rewriteGitStatusBlock(CAPTURED, { ...FACTS, user: null });
  check('the Git user section is gone', !out.includes('Git user:'));
  check('the capture\'s identity is not left standing in its place',
    !out.includes('dario'));
  check('everything else still renders', out.includes('Current branch: master')
    && out.includes('Status:\n M src/pool.ts') && out.includes('Recent commits:\nc07631f docs'));
}

// ─────────────────────────────────────────────────────────────
header('rewrite — a section CC adds later is not dropped');
{
  const future = `${CAPTURED}\n\nUpstream: origin/main (2 ahead)`;
  const out = rewriteGitStatusBlock(future, FACTS);
  check('an unrecognized section passes through untouched',
    out.endsWith('Upstream: origin/main (2 ahead)'));
}

// ─────────────────────────────────────────────────────────────
header('extract — boundaries');
{
  const prompt = `# Memory\nm\n\n# Context management\nc\n\n${CAPTURED}`;
  check('extracted from the end of a prompt', extractGitStatusBlock(prompt) === CAPTURED);
  check('absent reads as null', extractGitStatusBlock('# Memory\nm\n') === null);
  check('a heading after the block bounds it',
    extractGitStatusBlock(`${prompt}\n\n# Trailing\nt\n`) === CAPTURED);
  check('the label only counts at the start of a line',
    extractGitStatusBlock('see gitStatus: for details\n') === null);
}

// ─────────────────────────────────────────────────────────────
header('splice — replace, append, remove');
{
  const withBlock = `# Memory\nm\n\n${CAPTURED}`;
  const replaced = spliceGitStatusBlock(withBlock, 'gitStatus: new');
  check('an existing block is replaced', replaced === '# Memory\nm\n\ngitStatus: new');
  check('only one block after a replace',
    replaced.split('gitStatus:').length - 1 === 1);

  const appended = spliceGitStatusBlock('# Memory\nm\n', 'gitStatus: new');
  check('a prompt with none gets it last', appended === '# Memory\nm\n\ngitStatus: new');

  // Removal is the exact inverse of the append above, so a prompt that gets a
  // block and then loses it is byte-identical to one that never had one.
  check('null removes an existing block',
    spliceGitStatusBlock(withBlock, null) === '# Memory\nm\n');
  check('append then remove round-trips',
    spliceGitStatusBlock(spliceGitStatusBlock('# Memory\nm\n', CAPTURED), null) === '# Memory\nm\n');
  check('null on a prompt with none is a no-op',
    spliceGitStatusBlock('# Memory\nm\n', null) === '# Memory\nm\n');
}

// ─────────────────────────────────────────────────────────────
header('apply — the two ways there is nothing to say');
{
  const prompt = `# Memory\nm\n\n${CAPTURED}`;
  check('no captured shape leaves the prompt alone',
    applyGitStatusBlock(prompt, null, FACTS) === prompt);
  check('a host outside a repo has its block removed, as CC would send none',
    applyGitStatusBlock(prompt, CAPTURED, null) === '# Memory\nm\n');
  check('captured shape plus facts rewrites',
    applyGitStatusBlock(prompt, CAPTURED, FACTS).includes('Git user: chaogebaba'));
}

// ─────────────────────────────────────────────────────────────
header('detect — read off a real repository');
{
  const dirty = scratchRepo((git, dir) => {
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'first');
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    writeFileSync(join(dir, 'b.txt'), 'b\n');
  });
  const f = detectGitStatusFacts(dirty);
  check('branch read', f?.branch === 'main');
  check('user read', f?.user === 'probe-user');
  check('status lists both the edit and the untracked file',
    f?.status.includes(' M a.txt') && f?.status.includes('?? b.txt'));
  check('the porcelain column is preserved, not trimmed off the first line',
    f?.status.startsWith(' M a.txt'));
  check('commits read', /^[0-9a-f]{7,} first$/.test(f?.recentCommits ?? ''));

  const clean = scratchRepo((git, dir) => {
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'only');
  });
  check('a clean tree reports an empty status, which the rewrite renders as CC does',
    detectGitStatusFacts(clean)?.status === '');

  const many = scratchRepo((git, dir) => {
    for (let i = 1; i <= 8; i++) {
      writeFileSync(join(dir, `f${i}.txt`), `${i}\n`);
      git('add', '-A');
      git('commit', '-q', '-m', `commit ${i}`);
    }
  });
  check('exactly five commits, matching what CC lists',
    detectGitStatusFacts(many)?.recentCommits.split('\n').length === 5);
  check('newest first', detectGitStatusFacts(many)?.recentCommits.split('\n')[0].endsWith('commit 8'));

  // A machine with no git identity — a container, a CI runner — still has a
  // branch, a status and a log, and CC would still send a block.
  const noIdentity = scratchRepo((git, dir) => {
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'first');
    git('config', '--unset', 'user.name');
  });
  const ni = detectGitStatusFacts(noIdentity);
  check('an unset user.name does not sink the whole block', ni !== null);
  check('...it reads as null, for the rewrite to drop', ni?.user === null);
  check('...while the branch is still read', ni?.branch === 'main');

  // A fresh repo has no HEAD to resolve, which is where `--abbrev-ref` fails
  // and `--show-current` still answers.
  const unborn = scratchRepo(() => { /* init only */ });
  check('a repo with no commits still names its unborn branch',
    detectGitStatusFacts(unborn)?.branch === 'main');
  check('...and reports no commits, which the rewrite drops',
    detectGitStatusFacts(unborn)?.recentCommits === '');

  const notARepo = mkdtempSync(join(tmpdir(), 'dario-gitstatus-plain-'));
  TMP.push(notARepo);
  check('a directory outside any repo reads as null', detectGitStatusFacts(notARepo) === null);
}

// ─────────────────────────────────────────────────────────────
header('detect — the PR-target branch, as CC picks it');
{
  const onlyMaster = scratchRepo((git, dir) => {
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'first');
    git('branch', '-m', 'master');
  });
  check('a repo with only master is told master', detectGitStatusFacts(onlyMaster)?.mainBranch === 'master');

  const both = scratchRepo((git, dir) => {
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'first');
    git('branch', 'master');
    git('checkout', '-q', '-b', 'feature');
  });
  check('main wins over master when both exist', detectGitStatusFacts(both)?.mainBranch === 'main');
  check('...while the current branch is still the one checked out',
    detectGitStatusFacts(both)?.branch === 'feature');

  const neither = scratchRepo((git, dir) => {
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'first');
    git('branch', '-m', 'trunk');
  });
  check('a repo with neither is still told main, exactly as CC says',
    detectGitStatusFacts(neither)?.mainBranch === 'main');
}

// ─────────────────────────────────────────────────────────────
header('the capture sandbox is a repository, which is where the shape comes from');
{
  // A bare temp dir makes CC emit no gitStatus at all — measured against CC
  // 2.1.236 — so there is nothing to rewrite and the block can only be
  // invented, which this codebase does not do. Seeding the sandbox is what
  // makes the shape available.
  const home = mkdtempSync(join(tmpdir(), 'dario-capture-seed-'));
  TMP.push(home);
  _seedCaptureRepoForTest(home);
  const facts = detectGitStatusFacts(home);
  check('the sandbox is a git repository afterwards', facts !== null);
  check('on a named branch', facts?.branch === 'main');
  check('with a commit, so CC has a log to render', (facts?.recentCommits ?? '').length > 0);
  // CC renders a clean tree as the literal `(clean)`, and that word is the
  // fallback the rewrite leans on when the SERVING repo has nothing modified.
  // A sandbox left dirty would put its own junk there instead.
  check('and a clean tree, so the captured Status body is CC\'s own "(clean)"',
    facts?.status === '');

  // The operator's own git config must not reach inside: an init.templateDir
  // or a core.hooksPath would run their code in the capture. Read defensively
  // so an unseeded dir reports a failed assertion instead of killing the run
  // and taking the tally with it.
  const configPath = join(home, '.git', 'config');
  const config = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';
  check('hooks are pointed away from anything runnable', config.includes('hooksPath'));

  // Best-effort by contract: a host with no usable git leaves a plain
  // directory, which is the behaviour that shipped before this existed.
  const twice = mkdtempSync(join(tmpdir(), 'dario-capture-seed-'));
  TMP.push(twice);
  _seedCaptureRepoForTest(twice);
  _seedCaptureRepoForTest(twice);
  check('seeding an already-seeded dir does not throw or lose the repo',
    detectGitStatusFacts(twice) !== null);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
