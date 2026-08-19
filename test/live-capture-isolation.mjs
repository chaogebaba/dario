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

// The child's environment is built, not inherited-and-patched. These two
// pin the SEAM only — that the spawn goes through the allowlist and hands it
// the real process environment. What the allowlist keeps out is asserted
// behaviourally at the bottom of this file, against the exported function,
// because a denylist of `delete` lines is exactly what could not be trusted:
// every variable nobody had thought to name still reached the child.
check(
  'the spawn builds its environment through captureChildEnv',
  /const env = captureChildEnv\(process\.env, \{/.test(spawnBlock),
);
check(
  'nothing re-spreads process.env into the child environment',
  // comments stripped: the block explains what it replaced, in prose that
  // contains the very spread this forbids in code
  !/\.\.\.process\.env/.test(spawnBlock.replace(/^\s*\/\/.*$/gm, '')),
);
// The MITM authenticates nothing, so a real key bought nothing and put a live
// credential in a child we are deliberately pointing at a socket.
check(
  'the child gets the placeholder API key, never the operator\'s',
  /ANTHROPIC_API_KEY: 'sk-dario-fingerprint-capture'/.test(spawnBlock)
  && !/ANTHROPIC_API_KEY: process\.env\.ANTHROPIC_API_KEY/.test(spawnBlock),
);

// CLAUDE_CONFIG_DIR cannot relocate the machine-level policy file, whose env
// block outranks everything. Refuse the spend rather than rediscover the bug.
check(
  'capture bails when managed settings would override the sandbox',
  /export function managedSettingsHijack\(paths\?: string\[\]\)/.test(src)
  && /const managed = managedSettingsHijack\(\);/.test(src),
);
check(
  'the managed-settings bail is a distinct log line, and names the key it found',
  /live capture skipped: \$\{managed\.path\} sets \$\{managed\.key\}/.test(src),
);

// The base dirs are read out of the CC binary, not inferred from docs. The
// Windows one is `Program Files`; an earlier cut of this guard used
// `ProgramData`, which appears NOWHERE in the binary — so the bail would have
// silently never fired on Windows while the suite stayed green, because the
// test asserted the same wrong constant the implementation used.
check(
  'macOS managed base dir matches CC',
  /'\/Library\/Application Support\/ClaudeCode'/.test(src),
);
check(
  'Windows managed base dir is Program Files, not ProgramData',
  src.includes("'C:\\\\Program Files\\\\ClaudeCode'") && !src.includes('ProgramData\\\\ClaudeCode'),
);
check('Linux managed base dir matches CC', /'\/etc\/claude-code'/.test(src));
check(
  'the managed-settings.d drop-in dir is scanned too',
  /join\(baseDir, 'managed-settings\.d'\)/.test(src) && /readdirSync\(dropIn\)/.test(src),
);

// The sound backstop: whatever config layer won, either the nonce'd request
// arrived or it went elsewhere and was billed. This is the check that would
// have caught the original bug on day one.
check(
  'a spawned-but-unreached capture warns that it may have been billed',
  /result === null && childSpawned && foreign === 0/.test(src)
  && /BILLED to your subscription/.test(src),
);
// The branch also catches a child that exited without sending anything, so the
// wording must not assert billing as fact — loud beats silent, but not by lying.
check(
  'the warning admits the non-billed possibility instead of asserting billing',
  /or it exited without sending one/.test(src),
);
check(
  'an exec failure retracts childSpawned so the billed warning cannot misfire',
  /child\.on\('error', \(\) => \{ childSpawned = false; settle\(null\); \}\)/.test(src),
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
// The variant sweep passes its family's model as an argument, so the pin is a
// chain now. What must not change is the tail: an unpinned capture would use
// whatever model the operator has set as their default, which is how the
// captured base became machine-specific in the first place.
check(
  'the base-prompt model is still pinned',
  /ANTHROPIC_MODEL:\s*(?:model\s*\?\?\s*)?process\.env\.ANTHROPIC_MODEL\s*\?\?\s*TEMPLATE_BASE_MODEL/.test(spawnBlock),
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
  /child\??\.kill\('SIGKILL'\)/.test(src) && !/kill\('SIGTERM'\)/.test(src),
);
check(
  'cleanup is driven by the child exit event, not a timer race',
  /child\.once\('exit', sweep\)/.test(src),
);
check(
  'a backstop sweep exists and is unref\'d so it cannot delay shutdown',
  /setTimeout\(sweep, 30_000\)/.test(src) && /backstop\.unref\(\)/.test(src),
);

// The above three all held while the capture still stranded its config dir,
// which is why they are not enough on their own. They assert that a sweep is
// ARMED on the exit event; they say nothing about a `settle` that runs when the
// child has ALREADY exited. On that path the `exitCode === null` guard was
// false, so nothing was armed, `kill` was a no-op on a corpse, and the
// `if (!child)` fallback was false because the child object still existed.
//
// Guaranteed on the failed-capture path (a child that exits without sending
// settles from its own `exit` handler), which is the path that repeats once per
// proxy start for as long as capture is broken; racy on the success path, where
// a 500ms request-arrived timer and a 200ms child-exited timer decide it.
// Verified A/B against a stub binary that exits without sending: unfixed
// stranded one dir per run, fixed stranded none. 19 had accumulated on the
// audit machine, each holding a full .claude.json and a session transcript.
check(
  'an already-exited child is swept immediately instead of being handed a handler that will never fire',
  /\}\s*else\s*\{[\s\S]{0,1400}?sweep\(\);\s*\n\s*\}/.test(src),
);
check(
  'the unreachable `if (!child) sweep()` fallback is gone',
  !/if \(!child\) sweep\(\);/.test(src),
);
// Both the live branch and the already-dead branch must end in a sweep, so
// there is no settle path that returns without cleaning up.
check(
  'the kill moved inside the still-running branch, where the child is known to exist',
  /child\.once\('exit', sweep\)[\s\S]{0,400}child\.kill\('SIGKILL'\)/.test(src),
);

// Everything above arms cleanup on the CHILD. All of it is cancelled by the
// PARENT exiting first: the `exit` event is never delivered, and the 30s
// backstop is unref'd precisely so it cannot hold the process open. So any
// dario invocation shorter than its own capture stranded a dir — `doctor`,
// `--version`, any CLI path that arms the background refresh and returns in
// milliseconds, and every test that starts a proxy without noLiveCapture.
// Verified A/B against a stub binary that outlives its parent: with the
// tracking stubbed out, one dir per run; with it, none.
check(
  'the capture dir is registered for sweeping at mkdtemp, not only inside settle',
  /captureHome = mkdtempSync\(join\(tmpdir\(\), 'dario-capture-'\)\);\s*\n\s*trackCaptureHome\(captureHome\);/.test(src),
);
check(
  'a process-exit hook sweeps any capture dir still pending',
  /process\.on\('exit',[\s\S]{0,300}rmSync\(dir, \{ recursive: true, force: true \}\)/.test(src),
);
check(
  'the exit hook is armed once, not once per capture',
  /if \(captureExitHookArmed\) return;\s*\n\s*captureExitHookArmed = true;/.test(src),
);
check(
  'a normal sweep deregisters, so a long-lived proxy does not accumulate dead paths',
  /releaseCaptureHome\(home\);/.test(src)
  && /function releaseCaptureHome[\s\S]{0,200}PENDING_CAPTURE_HOMES\.delete\(home\)/.test(src),
);

// The MITM must never become a forwarding proxy: it answers locally.
const mitmOk = /res\.writeHead\(200,\s*\{[\s\S]{0,200}text\/event-stream/.test(src)
  && !/fetch\(\s*['"`]https:\/\/api\.anthropic\.com/.test(src);
check('capture MITM answers locally and never forwards upstream', mitmOk);

// --- behavioural: what the child's environment actually contains ---
//
// Every name below was measured reaching a real spawned child on the version
// of this file that deleted four variables by hand. They are not deleted now;
// they are absent because they were never copied. The list is here as
// evidence of the failure mode, not as the mechanism — a name nobody thought
// of is covered by the same allowlist that covers these.
const { captureChildEnv, managedSettingsHijack } = await import('../dist/live-fingerprint.js');

const HIJACK_VARS = [
  // the original four
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  // five more platform switches, each with a matching base-URL variable
  'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_GATEWAY', 'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  // endpoint overrides; the unix socket bypasses the base URL entirely
  'ANTHROPIC_API_HOST', 'ANTHROPIC_UNIX_SOCKET', 'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_AWS_BASE_URL',
  'ANTHROPIC_GOOGLE_CLOUD_BASE_URL', 'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  // carries auth to whichever endpoint wins, and pollutes the captured header order
  'ANTHROPIC_CUSTOM_HEADERS',
  // CC reads this file and applies it as the session environment
  'CLAUDE_ENV_FILE',
  // the MITM is plain http on loopback, so a proxy with no NO_PROXY entry takes the call
  'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy',
  'CLAUDE_CODE_HTTP_PROXY', 'CLAUDE_CODE_HTTPS_PROXY',
  // a developer's shell adds these; they make a hand-run capture-and-bake
  // record a child-session fingerprint
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_EFFORT',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  // arbitrary code into the child
  'NODE_OPTIONS', 'ANTHROPIC_API_KEY',
];

const POISONED = { PATH: '/usr/bin', HOME: '/home/op', LC_ALL: 'C', TERM: 'xterm' };
for (const k of HIJACK_VARS) POISONED[k] = 'poison';
const PINNED = {
  CLAUDE_CONFIG_DIR: '/tmp/dario-capture-test',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/nonce',
  ANTHROPIC_API_KEY: 'sk-dario-fingerprint-capture',
  ANTHROPIC_MODEL: 'claude-haiku-4-5-20251001',
  CLAUDE_NONINTERACTIVE: '1',
};
const childEnv = captureChildEnv(POISONED, PINNED, 'linux');

const leaked = HIJACK_VARS.filter((k) => childEnv[k] === 'poison');
check(
  `none of the ${HIJACK_VARS.length} known hijack variables reach the child (leaked: ${leaked.join(', ') || 'none'})`,
  leaked.length === 0,
);
// The two the sandbox sets itself must be the sandbox's values, not the
// operator's — an allowlist that let the base shadow a pinned key would be
// the original bug with extra steps.
check(
  'the pinned base URL wins over a poisoned inherited one',
  childEnv.ANTHROPIC_BASE_URL === 'http://127.0.0.1:9/nonce',
);
check(
  'the pinned placeholder key wins over an inherited real one',
  childEnv.ANTHROPIC_API_KEY === 'sk-dario-fingerprint-capture',
);
// The two above pass on either merge order, because no pinned key is on the
// allowlist today — they guard the day someone adds one. This one pins the
// order itself, on a key that is on both sides.
check(
  'a pinned value wins over an allowlisted inherited one of the same name',
  captureChildEnv({ PATH: '/poison' }, { PATH: '/sandbox' }, 'linux').PATH === '/sandbox',
);
// ...and enough survives to actually run a binary.
check('PATH survives — the child has to find CC, git and rg', childEnv.PATH === '/usr/bin');
check('HOME survives — a wrapper script may resolve itself against it', childEnv.HOME === '/home/op');
check('LC_* survives by prefix, not by enumeration', childEnv.LC_ALL === 'C');
check('an unrecognized variable does not survive', !('FOO_UNKNOWN' in captureChildEnv({ FOO_UNKNOWN: 'x' }, {}, 'linux')));
check(
  'the allowlist is small — a large inherited environment collapses',
  Object.keys(captureChildEnv(POISONED, {}, 'linux')).length === 4,
);
// Windows names are conventionally mixed-case and Node's process.env is
// case-insensitive there, so the match is folded or the child loses its
// system paths and cannot spawn at all.
check(
  'win32 allowlist matches case-insensitively',
  captureChildEnv({ SYSTEMROOT: 'C:\\Windows', Path: 'C:\\bin' }, {}, 'win32').SYSTEMROOT === 'C:\\Windows',
);
check(
  'win32 does not carry the POSIX-only names',
  !('SHELL' in captureChildEnv({ SHELL: '/bin/sh' }, {}, 'win32')),
);

// --- behavioural: the managed-settings guard, against real files ---
// Injectable paths so this never touches a real machine-level policy path.
const tmp = mkdtempSync(join(tmpdir(), 'dario-managed-test-'));
const write = (name, obj) => {
  const p = join(tmp, name);
  writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return p;
};

check(
  'no managed file -> capture proceeds',
  managedSettingsHijack([join(tmp, 'does-not-exist.json')]) === null,
);
const hijack = write('hijack.json', { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721' } });
check(
  'managed file pinning ANTHROPIC_BASE_URL -> capture bails, and names the file',
  managedSettingsHijack([hijack])?.path === hijack,
);
check(
  'the bail names the key it found, not just the file',
  managedSettingsHijack([hijack])?.key === 'env.ANTHROPIC_BASE_URL',
);
check(
  'managed file with no hijacking key -> capture proceeds',
  managedSettingsHijack([write('other.json', { env: { FOO: 'bar' }, cleanupPeriodDays: 30 })]) === null,
);
check(
  'managed file with an empty base url is not treated as an override',
  managedSettingsHijack([write('empty.json', { env: { ANTHROPIC_BASE_URL: '' } })]) === null,
);
check(
  'malformed managed file does not throw or block capture',
  managedSettingsHijack([write('bad.json', '{not json')]) === null,
);
check(
  'first matching path wins when several are checked',
  managedSettingsHijack([join(tmp, 'nope.json'), hijack])?.path === hijack,
);

// The guard used to check ANTHROPIC_BASE_URL and nothing else: measured
// against the real function, it proceeded on all seventeen of these. The two
// platform switches are the sharpest — the spawn deleted both from the
// child's environment BECAUSE it knew they were billing routes, and named
// them in its own warning text, while this guard waved them through.
const OTHER_HIJACKS = [
  ['env', 'CLAUDE_CODE_USE_BEDROCK', true],
  ['env', 'CLAUDE_CODE_USE_VERTEX', '1'],
  ['env', 'CLAUDE_CODE_USE_FOUNDRY', '1'],
  ['env', 'CLAUDE_CODE_USE_GATEWAY', '1'],
  ['env', 'CLAUDE_CODE_USE_MANTLE', '1'],
  ['env', 'ANTHROPIC_API_HOST', 'api.elsewhere'],
  ['env', 'ANTHROPIC_UNIX_SOCKET', '/run/x.sock'],
  ['env', 'ANTHROPIC_BEDROCK_BASE_URL', 'https://x'],
  ['env', 'ANTHROPIC_VERTEX_BASE_URL', 'https://x'],
  ['env', 'ANTHROPIC_AUTH_TOKEN', 'sk-x'],
  ['env', 'ANTHROPIC_CUSTOM_HEADERS', 'x: y'],
  ['env', 'HTTPS_PROXY', 'http://proxy:8080'],
  ['env', 'CLAUDE_ENV_FILE', '/etc/claude.env'],
  // apiKeyHelper is the subtle one: the binary maps it to ANTHROPIC_BASE_URL,
  // so it sets the very variable the old guard checked, by a route it could
  // not see.
  ['top', 'apiKeyHelper', '/usr/local/bin/key.sh'],
  ['top', 'awsAuthRefresh', 'aws sso login'],
  ['top', 'gcpAuthRefresh', 'gcloud auth login'],
  ['top', 'forceLoginMethod', 'console'],
  ['top', 'primaryApiKey', 'sk-x'],
  // not billing — it defeats the ANTHROPIC_MODEL pin, so every family in the
  // variant sweep captures the same wrong prompt
  ['top', 'model', 'claude-opus-4-8'],
];
let bailed = 0;
const proceeded = [];
for (const [where, key, value] of OTHER_HIJACKS) {
  const body = where === 'env' ? { env: { [key]: value } } : { [key]: value };
  const found = managedSettingsHijack([write(`h-${key}.json`, body)]);
  const want = where === 'env' ? `env.${key}` : key;
  if (found?.key === want) bailed++; else proceeded.push(key);
}
check(
  `every managed hijack key bails and is named (proceeded: ${proceeded.join(', ') || 'none'})`,
  bailed === OTHER_HIJACKS.length,
);
rmSync(tmp, { recursive: true, force: true });

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);