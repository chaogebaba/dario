#!/usr/bin/env bun
/**
 * Genuine-CC byte-faithful passthrough (dario#678 follow-up).
 *
 * A real Claude Code client's request already IS the CC wire shape. The
 * template pipeline used to prepend dario's ~25KB template prompt to the
 * client's own CC system prompt (re-billed per request shape per cache
 * window — the residual +5%-vs-direct in the #678 re-test), substitute
 * template tool defs for the client's own, truncate/scrub its content, and
 * round-robin natives the `--print` template capture never sees
 * (AskUserQuestion, plan-mode tools). Passthrough forwards system + tools +
 * messages verbatim; dario keeps only its billing tag, its metadata
 * identity, and deterministic cache breakpoints.
 *
 * In-process — no proxy / OAuth / upstream.
 */

import { buildCCRequest, applyCcPromptCaching, isGenuineCCClient, CC_SYSTEM_PROMPT } from '../dist/cc-template.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
}
function header(name) { console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`); }

const billingTag = 'x-anthropic-billing-header: cc_version=9.9.9; cc_entrypoint=sdk-cli;';
const cache = { type: 'ephemeral' };
const identity = { deviceId: 'dario-dev', accountUuid: 'dario-acct', sessionId: 'dario-sess' };

const CLIENT_IDENTITY = 'You are Claude Code, Anthropic\'s official CLI for Claude.';
const CLIENT_PROMPT = 'CLIENT-VERSION system prompt — newer than any template. '.repeat(50);
const BIG_RESULT = 'x'.repeat(40_000);

function ccClientBody() {
  return {
    model: 'claude-opus-4-8',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'read every file — mention Continue and Cline verbatim' }, { type: 'text', text: 'q', cache_control: { type: 'ephemeral' } }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'client thinking block, replayed by CC on purpose', signature: 'sig' },
          { type: 'tool_use', id: 'tu_1', name: 'AskUserQuestion', input: { questions: [{ question: 'which dir?' }] } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: BIG_RESULT, extra_client_field: 1 }] },
    ],
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.202.abc; cc_entrypoint=sdk-cli; ' },
      { type: 'text', text: CLIENT_IDENTITY, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: CLIENT_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
    ],
    tools: [
      { name: 'Read', description: 'CLIENT-VERSION Read def', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } },
      { name: 'AskUserQuestion', description: 'interactive-only native absent from --print captures', input_schema: { type: 'object', properties: { questions: { type: 'array' } } } },
      { name: 'mcp__srv__ping', description: 'client mcp def', input_schema: { type: 'object' } },
    ],
    metadata: { user_id: 'client-identity-should-be-replaced' },
    max_tokens: 64000,
    thinking: { type: 'adaptive', display: 'omitted' },
    context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
    output_config: { effort: 'xhigh' },
    stream: true,
  };
}

header('isGenuineCCClient — the billing-block discriminator');
{
  check('CC-shaped body detected', isGenuineCCClient(ccClientBody()));
  check('string system → not CC', !isGenuineCCClient({ system: 'plain prompt' }));
  check('array system without billing block → not CC',
    !isGenuineCCClient({ system: [{ type: 'text', text: 'You are a bot' }, { type: 'text', text: 'rules' }] }));
  check('single-block system → not CC',
    !isGenuineCCClient({ system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=1;' }] }));
  check('billing block + non-CC identity → not CC (replayed-tag Kilo shape)',
    !isGenuineCCClient({ system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=1;' },
      { type: 'text', text: 'You are Kilo Code, an open-source coding agent.' },
    ] }));
  check('Agent SDK identity variant detected', isGenuineCCClient({ system: [
    { type: 'text', text: 'x-anthropic-billing-header: cc_version=1;' },
    { type: 'text', text: 'You are a Claude agent, built on Anthropic\'s Claude Agent SDK.' },
  ] }));
}

header('isGenuineCCClient — CC-origin non-main-loop shapes (#678 remote re-test)');
{
  // Sub-agent (Task/Agent tool) request. Opener is the exact prompt text in
  // the CC v2.1.205 bundle — it neither starts with "You are Claude Code"
  // nor mentions the Agent SDK, so the v4.8.146 detector dropped every
  // sub-agent turn onto the template path.
  check('sub-agent request detected', isGenuineCCClient({ system: [
    { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.205.abc; cc_entrypoint=cli;' },
    { type: 'text', text: 'You are an agent for Claude Code, Anthropic\'s official CLI for Claude. Given the user\'s message, you should use the tools available to complete the task.' },
  ] }));
  // Auto-mode permission classifier — fired once per gated tool call,
  // including per Agent spawn. Shape from a live loopback capture of CC
  // v2.1.205 (~106KB system[1], zero tools).
  check('auto-mode permission-classifier request detected', isGenuineCCClient({ system: [
    { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.205.331; cc_entrypoint=sdk-cli;' },
    { type: 'text', text: 'You are a security monitor for autonomous AI coding agents.\n\n## Context\n\nThe agent you are monitoring is an **autonomous coding agent** with shell access…', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: '\n\n## Session Context\n\n- **User identity**: `user`.' },
  ] }));
  // Built-in NAMED agents (the #678 reporter's v4.8.148 residual: forced
  // parallel sub-agents still burned ~3x direct per spawn — CC routes
  // "read every file" prompts to Explore-type agents). Openers are the
  // exact bytes from the CC v2.1.205 bundle.
  check('built-in Explore agent detected', isGenuineCCClient({ system: [
    { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.205.abc; cc_entrypoint=cli;' },
    { type: 'text', text: 'You are a file search specialist for Claude Code, Anthropic\'s official CLI for Claude. You excel at thoroughly navigating and exploring codebases.' },
  ] }));
  check('built-in Plan agent detected', isGenuineCCClient({ system: [
    { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.205.abc; cc_entrypoint=cli;' },
    { type: 'text', text: 'You are a software architect and planning specialist for Claude Code. Your role is to explore the codebase and design implementation plans.' },
  ] }));
  // CUSTOM agents (~/.claude/agents) carry operator-authored text with no CC
  // marker. That used to drop them on the template path — the documented gap
  // under the opener list. They are CC requests: CC built them, CC sent them,
  // and they carry CC's billing block. Recognising them is the point of
  // dropping the opener list, not a leak.
  check('custom-agent definition text is CC', isGenuineCCClient({ system: [
    { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.205.abc; cc_entrypoint=cli;' },
    { type: 'text', text: 'You are a meticulous database migration reviewer. Inspect every schema change for backwards compatibility.' },
  ] }));
  // The billing block is load-bearing: without it, CC-looking prose at
  // system[1] is not enough.
  check('sub-agent opener WITHOUT billing block → not CC', !isGenuineCCClient({ system: [
    { type: 'text', text: 'You are an agent for Claude Code, Anthropic\'s official CLI for Claude.' },
    { type: 'text', text: 'rules' },
  ] }));
  // A named foreign client is still rejected however much CC preamble it
  // replays — that discrimination moved from the opener list to
  // detectTextToolClient, it did not go away.
  check('billing block + Roo identity → not CC', !isGenuineCCClient({ system: [
    { type: 'text', text: 'x-anthropic-billing-header: cc_version=1;' },
    { type: 'text', text: 'You are Roo, a helpful AI coding assistant. Use the tools provided.' },
  ] }));
  check('billing block + Hermes attribution → not CC', !isGenuineCCClient({ system: [
    { type: 'text', text: 'x-anthropic-billing-header: cc_version=1;' },
    { type: 'text', text: 'A capable assistant created by Nous Research.' },
  ] }));
}

header('passthrough — sub-agent body forwarded verbatim (#678 remote re-test)');
{
  const SUBAGENT_PROMPT = 'You are an agent for Claude Code, Anthropic\'s official CLI for Claude. Given the user\'s message, you should use the tools available to complete the task.';
  const subagentBody = {
    model: 'claude-opus-4-8',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word done.' }] }],
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.205.abc; cc_entrypoint=cli; ' },
      { type: 'text', text: SUBAGENT_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    // Sub-agents declare a REDUCED native set (no Agent). The template path
    // used to rebuild this from template defs; passthrough must forward it.
    tools: [
      { name: 'Read', description: 'SUBAGENT-CLIENT Read def', input_schema: { type: 'object' } },
      { name: 'Grep', description: 'SUBAGENT-CLIENT Grep def', input_schema: { type: 'object' } },
    ],
    max_tokens: 32000,
    stream: true,
  };
  const { body, genuineCC } = buildCCRequest(subagentBody, billingTag, cache, identity, {});
  check('genuineCC flag set for sub-agent body', genuineCC === true);
  check('system[1] agent prompt VERBATIM (no template prepend)', body.system[1].text === SUBAGENT_PROMPT);
  check('template prompt NOT present anywhere', !JSON.stringify(body.system).includes(CC_SYSTEM_PROMPT.slice(0, 60)));
  check('reduced tool set forwarded exactly', body.tools.map((t) => t.name).join(',') === 'Read,Grep');
  check('client tool defs kept (no template substitution)', body.tools[0].description === 'SUBAGENT-CLIENT Read def');
}

header('passthrough — system verbatim, including the block dario used to overwrite');
{
  const { body, toolMap, unmappedTools, genuineCC } = buildCCRequest(ccClientBody(), billingTag, cache, identity, {});
  check('genuineCC flag set', genuineCC === true);
  check('toolMap empty (identity — no reverse rewriting)', toolMap.size === 0);
  check('no unmapped tools (nothing round-robined)', unmappedTools.length === 0);
  const sys = body.system;
  check('system block count preserved', Array.isArray(sys) && sys.length === 3);
  // dario used to stamp its own billingTag here. That tag is derived from the
  // template capture, which is taken with `claude -p`, so a real interactive
  // session went upstream claiming `cc_entrypoint=sdk-cli` while the same
  // request forwarded the client's `user-agent: … (external, cli)`. Recorded
  // off CC 2.1.236: client sends `…236.ce1; cc_entrypoint=cli;`, dario sent
  // `…236.43f; cc_entrypoint=sdk-cli;`. The client's block is the true one.
  check('system[0] = the CLIENT\'s billing tag, verbatim',
    sys[0].text === ccClientBody().system[0].text && sys[0].text !== billingTag);
  check('system[0] carries no breakpoint (client sent none)', !sys[0].cache_control);
  check('system[1] text VERBATIM client identity', sys[1].text === CLIENT_IDENTITY);
  check('system[2] text VERBATIM client prompt (no template prepend)', sys[2].text === CLIENT_PROMPT);
  check('template prompt NOT present anywhere', !JSON.stringify(sys).includes(CC_SYSTEM_PROMPT.slice(0, 60)));
  check('system[1] + system[2] stamped plain ephemeral', sys[1].cache_control?.type === 'ephemeral' && sys[2].cache_control?.type === 'ephemeral');
  check('client ttl stripped (budget-normalized restamp)', sys[2].cache_control.ttl === undefined);
}

header('passthrough — tools + messages verbatim');
{
  const { body } = buildCCRequest(ccClientBody(), billingTag, cache, identity, {});
  const names = body.tools.map((t) => t.name);
  check('client tool set forwarded exactly', names.join(',') === 'Read,AskUserQuestion,mcp__srv__ping');
  check('client Read def kept (no template substitution)', body.tools[0].description === 'CLIENT-VERSION Read def');
  check('AskUserQuestion advertised (no --print capture gap)', names.includes('AskUserQuestion'));
  const asst = body.messages[1];
  check('thinking block in history KEPT (CC replays them on purpose)', asst.content[0].type === 'thinking');
  check('tool_use name untouched', asst.content[1].name === 'AskUserQuestion');
  const result = body.messages[2].content[0];
  check('40KB tool_result NOT truncated', result.content.length === BIG_RESULT.length);
  check('client-specific tool_result fields kept', result.extra_client_field === 1);
  check('message text NOT scrubbed (Continue/Cline survive)', body.messages[0].content[0].text.includes('Continue') && body.messages[0].content[0].text.includes('Cline'));
  // CC plans its own cache layout across the turn; dario does not know which
  // prefix CC intends to reuse. It used to strip every client breakpoint and
  // re-place its own, which on a recorded /compact moved the one conversation
  // breakpoint off messages[1] and onto messages[0] and messages[2] — 3
  // breakpoints became 4.
  check('client message cache_control kept where the client put it',
    body.messages[0].content[1].cache_control?.type === 'ephemeral');
}

header('passthrough — top-level fields are the client\'s, identity is dario\'s');
{
  const client = ccClientBody();
  const { body } = buildCCRequest(client, billingTag, cache, identity, {});
  check('model forwarded', body.model === 'claude-opus-4-8');
  check('max_tokens forwarded', body.max_tokens === 64000);
  check('thinking forwarded verbatim', JSON.stringify(body.thinking) === JSON.stringify(client.thinking));
  check('output_config.effort forwarded (client knob)', body.output_config.effort === 'xhigh');
  check('stream forwarded', body.stream === true);
  const uid = JSON.parse(body.metadata.user_id);
  check('metadata.user_id = dario identity (OAuth account is dario\'s)',
    uid.device_id === 'dario-dev' && uid.account_uuid === 'dario-acct' && uid.session_id === 'dario-sess');
  check('top-level key order preserved (client order + system in place)',
    Object.keys(body).join(',') === Object.keys(client).join(','));
}

header('passthrough outranks tool-mode flags (they exist for NON-CC clients)');
{
  const { body, genuineCC } = buildCCRequest(ccClientBody(), billingTag, cache, identity, { hybridTools: true });
  check('hybridTools ignored for genuine CC', genuineCC === true && body.tools[0].description === 'CLIENT-VERSION Read def');
  const merged = buildCCRequest(ccClientBody(), billingTag, cache, identity, { mergeTools: true });
  check('mergeTools ignored for genuine CC', merged.genuineCC === true && merged.body.tools.length === 3);
}

header('passthrough — the client\'s breakpoint layout survives intact');
{
  // The proxy no longer runs applyCcPromptCaching over a genuine-CC body (that
  // helper is for clients dario dresses up as CC). What CC sent is what goes
  // out, count and position both.
  const client = ccClientBody();
  const { body } = buildCCRequest(client, billingTag, cache, identity, {});
  const hasCC = (o) => !!(o && o.cache_control);
  const blocks = (b) => b.messages.flatMap((m) => Array.isArray(m.content) ? m.content : []);
  const positions = (b) => [
    ...b.system.map((s, i) => hasCC(s) ? `sys${i}` : null),
    ...blocks(b).map((c, i) => hasCC(c) ? `msg${i}` : null),
  ].filter(Boolean).join(',');

  check('breakpoint positions identical to the client\'s',
    positions(body) === positions(client));
  check('breakpoint count identical to the client\'s',
    body.system.filter(hasCC).length + blocks(body).filter(hasCC).length
      === client.system.filter(hasCC).length + blocks(client).filter(hasCC).length);
  check('no tool breakpoints invented', body.tools.filter(hasCC).length === 0);
  check('still inside the Anthropic 4-breakpoint budget',
    body.system.filter(hasCC).length + blocks(body).filter(hasCC).length <= 4);

  // The one thing dario still rewrites: the TTL, when the operator forces one.
  // Position is untouched — a forced TTL changes what a breakpoint means, not
  // where it is.
  const forced = buildCCRequest(ccClientBody(), billingTag, { type: 'ephemeral', ttl: '1h' }, identity, {});
  check('forced ttl applied to the client\'s own breakpoints',
    forced.body.system[1].cache_control.ttl === '1h');
  check('forced ttl does not add or move breakpoints',
    positions(forced.body) === positions(client));
}

header('non-CC clients keep the template pipeline');
{
  const nonCC = {
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    system: 'You are a helpful bot.',
    tools: [{ name: 'Read', description: 'x', input_schema: { type: 'object' } }],
  };
  const { body, genuineCC } = buildCCRequest(nonCC, billingTag, cache, identity, {});
  check('genuineCC not set', !genuineCC);
  check('template system injected (3 blocks)', Array.isArray(body.system) && body.system.length === 3);
  check('template prompt present', body.system[2].text.includes(CC_SYSTEM_PROMPT.slice(0, 60)));
}

console.log(`\ncc-passthrough: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
