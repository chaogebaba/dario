#!/usr/bin/env bun
// Claude Code fidelity — the two directions dario has to get right.
//
// Upstream-facing: a request CC sent must be forwarded as CC's own bytes, not
// rebuilt through the template. `isGenuineCCClient` is the switch, and it is
// the switch for `sanitizeMessages` too — a misclassified CC request has its
// `<system-reminder>` blocks scrubbed on the way out.
//
// Client-facing: dario must answer CC the way api.anthropic.com does, on the
// paths CC actually requests and with the headers CC actually parses.
//
// The regression this pins: the detector used to require system[1] to start
// with one of five hard-coded openers. CC v2.1.236 ships 20+ system prompts.
// Eleven of the ones below failed that list — including the summariser behind
// every `/compact`, which meant the transcript being summarised was scrubbed
// of the very reminders it was supposed to preserve.

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isGenuineCCClient } from '../dist/cc-template.js';
import { isForwardableUpstreamHeader } from '../dist/proxy.js';

let pass = 0, fail = 0;
function check(label, cond, ...rest) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`, ...rest); }
}
function header(name) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}

const BILLING = 'x-anthropic-billing-header: cc_version=2.1.236.abc; cc_entrypoint=cli;';
const ccBody = (opener) => ({
  system: [{ type: 'text', text: BILLING }, { type: 'text', text: `${opener}\n\n## Context\n…` }],
  messages: [{ role: 'user', content: 'hi' }],
});

// Openers harvested from the Claude Code v2.1.236 bundle. The first five are
// the ones the old allowlist carried; the rest are the ones it missed.
const CC_OPENERS = [
  'You are Claude Code, Anthropic\'s official CLI for Claude.',
  'You are an agent for Claude Code, Anthropic\'s official CLI for Claude.',
  'You are a file search specialist for Claude Code, Anthropic\'s official CLI.',
  'You are a software architect and planning specialist for Claude Code',
  'You are a security monitor for autonomous AI coding agents',
  'You are a helpful AI assistant tasked with summarizing conversations',
  'You are a code review specialist focused on identifying issues across security',
  'You are a senior security engineer conducting a focused security review of the',
  'You are a web-reading specialist for Claude Code, Anthropic',
  'You are answering a question about Claude Code itself',
  'You are a subagent spawned by a workflow orchestration script',
  'You are an assistant for performing a web search tool use',
  'You are a ticket analysis specialist',
  'You are a background observer paired with the agent',
  'You are a teammate in this session',
  'You are an expert reviewer of auto mode classifier rules for Claude Code',
  'You are a Claude agent, built on Anthropic\'s Claude Agent SDK.',
  'You are an edit-capable composer for this thread',
  'You are a reply-only composer with NO tools',
  'You are capturing this session',
];

header('every Claude Code system prompt is recognised as Claude Code');
for (const opener of CC_OPENERS) {
  check(opener.slice(0, 62), isGenuineCCClient(ccBody(opener)));
}

header('operator-authored prompts are Claude Code too');
{
  // A ~/.claude/agents definition, an output style, and a /skill prompt all put
  // arbitrary text at system[1]. CC built and sent them; there is no marker to
  // enumerate, which is exactly why enumerating was the wrong approach.
  check('custom sub-agent definition',
    isGenuineCCClient(ccBody('You are a meticulous database migration reviewer.')));
  check('operator output style',
    isGenuineCCClient(ccBody('Respond in the voice of a terse staff engineer.')));
}

header('the billing block is what carries the claim');
{
  check('no billing block → not CC',
    !isGenuineCCClient({ system: [
      { type: 'text', text: 'You are Claude Code, Anthropic\'s official CLI for Claude.' },
      { type: 'text', text: 'rules' },
    ] }));
  check('single-block system → not CC',
    !isGenuineCCClient({ system: [{ type: 'text', text: BILLING }] }));
  check('string system → not CC', !isGenuineCCClient({ system: 'plain prompt' }));
  check('no system → not CC', !isGenuineCCClient({ messages: [] }));
}

header('a named foreign client is still rejected, however much preamble it replays');
for (const [name, text] of [
  ['Cline', 'You are Cline, a highly skilled software engineer.'],
  ['Kilo', 'You are Kilo Code, an open-source coding agent.'],
  ['Roo', 'You are Roo, a helpful AI coding assistant.'],
  ['Hermes', 'You are Hermes Agent, created by Nous Research.'],
  ['arnie', 'You are Arnie, a portable IT tech troubleshooting assistant running as a CLI.'],
]) {
  check(`${name} with a replayed billing block → not CC`, !isGenuineCCClient(ccBody(text)));
}

header('response headers Claude Code parses are forwarded');
for (const h of [
  'anthropic-ratelimit-unified-status',
  'anthropic-ratelimit-unified-reset',
  'anthropic-ratelimit-unified-overage-status',
  'anthropic-ratelimit-unified-grace-status',
  'anthropic-ratelimit-unified-upgrade-paths',
  'x-ratelimit-limit-requests',
  'request-id',
  'retry-after',        // was missing from the success path
  'x-should-retry',     // was missing from all three
  'anthropic-organization-id',
  'anthropic-usage-limit',
]) {
  check(h, isForwardableUpstreamHeader(h));
}
check('an unrelated upstream header is not forwarded',
  !isForwardableUpstreamHeader('x-envoy-upstream-service-time'));
check('set-cookie is not forwarded', !isForwardableUpstreamHeader('set-cookie'));

header('the claim does not depend on system[1] wording');
{
  // The invariant that replaced the opener list, stated directly: given CC's
  // billing block, what system[1] says does not change the verdict unless it
  // names a known foreign client. This is what stops an allowlist from being
  // reintroduced — any enumeration of CC's prompts fails these three.
  for (const odd of [
    'Zzzz nonsense prompt text that matches nothing at all',
    '',
    '\u4f60\u662f\u4e00\u4e2a\u4ee3\u7406',
  ]) {
    check(`billing block + ${JSON.stringify(odd.slice(0, 24))} → CC`,
      isGenuineCCClient(ccBody(odd)));
  }
}

// ── Drift guard ──────────────────────────────────────────────────────────
// Read every "You are …" string the installed bundle ships and assert none of
// them is misread as a foreign client. This is a collision check, not proof
// that each string is a system prompt — the bundle mixes prompts with
// user-facing copy ("You are likely on an immutable system such as NixOS"),
// and the predicate deliberately does not care which is which. What it catches
// is a CC release whose prompt wording trips detectTextToolClient, which is
// the one way a genuine CC request can still be classified foreign.
header('drift guard — no bundle string is misread as a foreign client');
const CC_BIN = [
  `${process.env.HOME}/.bun/install/global/node_modules/@anthropic-ai/claude-code/bin/claude.exe`,
  `${process.env.HOME}/.claude/local/node_modules/@anthropic-ai/claude-code/cli.js`,
].find((p) => existsSync(p));

if (!CC_BIN) {
  console.log('SKIP: no Claude Code bundle installed to diff against');
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

const strings = execFileSync('strings', ['-n', '20', CC_BIN], {
  maxBuffer: 512 * 1024 * 1024, encoding: 'utf8',
});
const found = [...new Set(
  strings.split('\n')
    .map((l) => /^(You are [A-Za-z][A-Za-z ,'-]{10,70})/.exec(l)?.[1])
    .filter(Boolean),
)];
console.log(`  bundle: ${CC_BIN.split('/').slice(-3).join('/')}`);
console.log(`  ${found.length} distinct "You are …" openers found`);
const rejected = found.filter((o) => !isGenuineCCClient(ccBody(o)));
check(`no bundle string is misread as foreign (${found.length - rejected.length}/${found.length})`,
  rejected.length === 0, `\n    rejected:\n      ${rejected.join('\n      ')}`);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
