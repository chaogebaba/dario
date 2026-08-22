#!/usr/bin/env bun
/**
 * Where `isGenuineCCClient` stops saying yes, and what it costs when it does.
 *
 * For the use case dario is aimed at — proxying the newest Claude Code and
 * nothing else — this predicate is the whole product. Everything downstream of
 * it is byte-faithful (test/cc-passthrough-fidelity.mjs proves that against
 * real 2.1.239 traffic), so the one way the 1:1 claim breaks in practice is a
 * miss here. Other suites check that real requests are recognised. This one
 * checks the edges: what a near-miss costs, which signals are load-bearing,
 * and which plausible-looking hardening would make things worse.
 *
 * The cost, measured rather than asserted. Take a real 2.1.239 main-loop body,
 * rename the one header the body test keys on, and run it through
 * buildCCRequest:
 *
 *     system prompt   11,813 → 40,369 bytes
 *     max_tokens      32,000 → 64,000
 *     thinking        {adaptive/31999} → dropped
 *     context_management                → dropped
 *     tools           56 remapped, Artifact / RemoteTrigger /
 *                     WaitForMcpServers gone
 *     key order       model,messages,system,tools,metadata,max_tokens,
 *                     thinking,context_management,stream
 *                   → model,messages,system,tools,metadata,max_tokens,stream
 *
 * Silently, on every turn, with the client none the wiser. That is why the
 * header identity was promoted from "the quota probe's special case" to a
 * second positive signal: the billing block is a private CC detail and nothing
 * obliges a future release to keep spelling it the same way.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isGenuineCCClient, hasCCIdentityHeaders, buildCCRequest } from '../dist/cc-template.js';

let pass = 0, fail = 0;
function check(label, cond, ...rest) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`, ...rest); }
}
function header(name) { console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`); }

const DIR = join(import.meta.dirname, 'fixtures', 'cc-wire-2.1.239');
const FIXTURES = readdirSync(DIR)
  .filter((f) => f.endsWith('.json') && f !== 'index.json')
  .map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')))
  .filter((c) => c.request.method === 'POST');

const CC_HEADERS = { 'user-agent': 'claude-cli/2.1.239 (external, cli)', 'x-app': 'cli' };
const BILLING = 'x-anthropic-billing-header: cc_version=2.1.239.73c; cc_entrypoint=cli;';
const CLI_LINE = "You are Claude Code, Anthropic's official CLI for Claude.";

/** A body in CC's shape, with whatever system[1] the caller wants to try. */
const ccBody = (second = CLI_LINE, first = BILLING) => ({
  system: [{ type: 'text', text: first }, { type: 'text', text: second }],
});

// ======================================================================
header('the three things CC ever puts at system[1]');
{
  // Recorded, not reasoned about. 21 real POST bodies across headless,
  // interactive and sub-agent runs of 2.1.239: every system array was exactly
  // three blocks, every system[0] carried the billing header, and system[1]
  // was one of these three strings. The operator's own text — a
  // ~/.claude/agents definition, an output style — lands at system[2].
  const SYS1 = new Set([
    "You are Claude Code, Anthropic's official CLI for Claude.",
    "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
    "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
  ]);
  const withSystem = FIXTURES.filter((c) => c.request.systemBlocks);
  check('the corpus has system-bearing captures', withSystem.length >= 5, withSystem.length);
  for (const c of withSystem) {
    const sb = c.request.systemBlocks;
    check(`${c.name}: three blocks`, sb.length === 3, sb.length);
    check(`${c.name}: billing at [0]`, (sb[0].text ?? '').startsWith('x-anthropic-billing-header:'));
    check(`${c.name}: CC's own line at [1]`, SYS1.has(sb[1].text ?? ''), sb[1].text);
  }
  const sub = FIXTURES.find((c) => c.name === 'subagent-cli');
  check('a sub-agent announces itself in the billing block',
    /cc_is_subagent=true/.test(sub?.request.systemBlocks?.[0].text ?? ''));
  check('and carries an agent id header',
    typeof sub?.request.headers['x-claude-code-agent-id'] === 'string');
  check("but its system[1] is still CC's wording, not the operator's",
    SYS1.has(sub?.request.systemBlocks?.[1].text ?? ''));
  check("the operator's agent prompt is at system[2]",
    (sub?.request.systemBlocks?.[2].chars ?? 0) > 1000);
}

// ======================================================================
header('either signal alone is enough');
{
  check('body alone, no headers offered', isGenuineCCClient(ccBody()) === true);
  check('headers alone, no system key',
    isGenuineCCClient({ messages: [] }, CC_HEADERS) === true);
  check('neither → not CC', isGenuineCCClient({ messages: [] }) === false);
  check('the sdk-cli entrypoint is CC too',
    hasCCIdentityHeaders({ 'user-agent': 'claude-cli/2.1.239 (external, sdk-cli)', 'x-app': 'cli' }));
}

// ======================================================================
header('a renamed billing block no longer loses the passthrough');
{
  // The version cliff. Before the header signal was promoted, this was the
  // whole failure: one private detail changes upstream and every request
  // quietly takes the template path.
  const drifted = ccBody(CLI_LINE, 'x-anthropic-billing: cc_version=9.9.9; cc_entrypoint=cli;');
  check('renamed header + CC headers → still CC', isGenuineCCClient(drifted, CC_HEADERS) === true);
  check('renamed header + no headers → not CC (body test is honest)',
    isGenuineCCClient(drifted) === false);

  const gone = { system: [{ type: 'text', text: CLI_LINE }, { type: 'text', text: 'rules' }] };
  check('billing block dropped entirely + CC headers → still CC',
    isGenuineCCClient(gone, CC_HEADERS) === true);

  const oneBlock = { system: [{ type: 'text', text: BILLING }] };
  check('a one-block system + CC headers → still CC', isGenuineCCClient(oneBlock, CC_HEADERS) === true);
  check('a one-block system alone → not CC', isGenuineCCClient(oneBlock) === false);
}

// ======================================================================
header('the foreign-client veto outranks both signals');
{
  // The veto is what keeps the header signal honest. A wrapper that forges
  // CC's user-agent while shipping its own prompt is not CC, and routing it
  // through the byte-faithful path would send that prompt upstream unmasked.
  for (const [name, text] of [
    ['Cline', 'You are Cline, a highly skilled software engineer.'],
    ['Kilo', 'You are Kilo Code, an open-source coding agent.'],
    ['Roo', 'You are Roo, a helpful AI coding assistant.'],
    ['Hermes', 'You are Hermes Agent, created by Nous Research.'],
    ['arnie', 'You are Arnie, a portable IT tech troubleshooting assistant.'],
    ['hands', 'You are a computer control agent with FULL access to this machine.'],
    ['cline-like', 'Invoke tools with <attempt_completion> when finished.'],
  ]) {
    check(`${name} + billing block + forged CC headers → not CC`,
      isGenuineCCClient(ccBody(text), CC_HEADERS) === false);
  }
}

// ======================================================================
header('header near-misses are not CC');
{
  const near = [
    ['no x-app', { 'user-agent': 'claude-cli/2.1.239 (external, cli)' }],
    ['x-app is not cli', { ...CC_HEADERS, 'x-app': 'web' }],
    ['no user-agent', { 'x-app': 'cli' }],
    ['wrong product', { ...CC_HEADERS, 'user-agent': 'claude-code/2.1.239 (external, cli)' }],
    ['not external', { ...CC_HEADERS, 'user-agent': 'claude-cli/2.1.239 (internal, cli)' }],
    ['no parenthetical', { ...CC_HEADERS, 'user-agent': 'claude-cli/2.1.239' }],
    ['two-part version', { ...CC_HEADERS, 'user-agent': 'claude-cli/2.1 (external, cli)' }],
    ['trailing junk', { ...CC_HEADERS, 'user-agent': 'claude-cli/2.1.239 (external, cli) curl/8' }],
    ['leading junk', { ...CC_HEADERS, 'user-agent': 'x claude-cli/2.1.239 (external, cli)' }],
    ['a plain SDK caller', { 'user-agent': 'anthropic-sdk-typescript/0.112.1', 'x-app': 'cli' }],
  ];
  for (const [label, h] of near) {
    check(`${label} → not CC`, isGenuineCCClient({ messages: [] }, h) === false);
  }
  // Case is not a signal: node lowercases incoming header names, but a caller
  // handing us a literal object should not be treated differently.
  check('header names are matched case-insensitively',
    hasCCIdentityHeaders({ 'User-Agent': 'claude-cli/2.1.239 (external, cli)', 'X-App': 'cli' }) === true);
  // A future entrypoint dario has never seen is still CC. The list of
  // entrypoints is Anthropic's to grow; pinning it would be the opener
  // allowlist all over again.
  check('an unseen entrypoint is still CC',
    hasCCIdentityHeaders({ ...CC_HEADERS, 'user-agent': 'claude-cli/3.0.0 (external, vscode)' }) === true);
}

// ======================================================================
header('the hardening that would have made this worse');
{
  // detectNonCCByTools is deliberately NOT part of the veto. Two or three
  // attached MCP servers push a real CC session past its 80% foreign-tool
  // line on their own — 28 of 52 tools seen live on this machine — so wiring
  // it in here would invent the exact false negative the predicate exists to
  // avoid. Pin that, so the next person who reaches for it sees why.
  const mcpHeavy = {
    ...ccBody(),
    tools: [
      ...Array.from({ length: 40 }, (_, i) => ({ name: `mcp__server__tool_${i}` })),
      { name: 'Bash' }, { name: 'Read' },
    ],
  };
  check('an MCP-heavy real CC session is still CC', isGenuineCCClient(mcpHeavy, CC_HEADERS) === true);

  // And the routing agrees: the passthrough keeps every tool, MCP included.
  const built = buildCCRequest(structuredClone(mcpHeavy), BILLING, { type: 'ephemeral' },
    { deviceId: 'd', accountUuid: 'a', sessionId: 's' }, { clientHeaders: CC_HEADERS });
  check('and all 42 of its tools survive the passthrough', built.body.tools.length === 42,
    built.body.tools?.length);
  check('with none of them remapped', built.toolMap.size === 0);
}

// ======================================================================
header('every recorded 2.1.239 request is still recognised');
{
  for (const c of FIXTURES) {
    const r = c.request;
    const body = r.systemBlocks
      ? { system: r.systemBlocks.map((b) => ({ type: 'text', text: b.text ?? 'x'.repeat(b.chars) })) }
      : { messages: [] };
    check(`${c.name}`, isGenuineCCClient(body, r.headers) === true);
  }
}

console.log(`\n  ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
