#!/usr/bin/env bun
/**
 * Request kinds the first recording never produced.
 *
 * test/cc-wire-fidelity.mjs pins the main loop, /compact, count_tokens and the
 * quota probe. Those were the shapes one ordinary coding session emits. This
 * suite covers four more, captured the same way (MITM proxy on
 * ANTHROPIC_BASE_URL, real credentials, sandboxed HOME + CLAUDE_CONFIG_DIR,
 * interactive CC 2.1.236 under tmux) by deliberately driving CC into them:
 *
 *   image-tool-result       — Read on a .png
 *   subagent-dispatch       — the Explore agent spawned for a Task
 *   web-search-server-tool  — CC's dedicated web-search turn
 *   thinking-turn           — assistant history carrying thinking blocks
 *
 * Each turned out to differ from the main loop in a way that matters:
 *
 *   1. An image is NOT a top-level content block. It arrives nested inside a
 *      tool_result's own content array, and the cache breakpoint sits on the
 *      tool_result that carries it. Any code walking `msg.content` one level
 *      deep does not see it at all.
 *   2. A subagent's billing block has a THIRD field, `cc_is_subagent=true`,
 *      and its system[1] is the Agent-SDK wording rather than the plain CLI
 *      line. dario's own billing tag emits two fields and the CLI wording.
 *   3. The web-search turn declares a SERVER tool — a `type` field and no
 *      input_schema — and comes with tool_choice, temperature, thinking
 *      disabled, no context_management, and a beta list carrying neither
 *      claude-code-20250219 nor extended-cache-ttl.
 *   4. Extended thinking is on by DEFAULT at budget 31999, paired with
 *      context_management clear_thinking_20251015.
 *
 * The suite is hermetic: no network, no credentials, no `claude` binary.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isGenuineCCClient, buildCCRequest } from '../dist/cc-template.js';

let pass = 0, fail = 0;
function check(label, cond, ...rest) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`, ...rest); }
}
function header(name) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}

const DIR = join(import.meta.dirname, 'fixtures', 'cc-wire-2.1.236');
const shape = (name) => JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8'));
const KINDS = ['image-tool-result', 'subagent-dispatch', 'web-search-server-tool', 'thinking-turn'];
const S = Object.fromEntries(KINDS.map((k) => [k, shape(k)]));
const websearchFull = JSON.parse(readFileSync(join(DIR, 'web-search-server-tool.full.json'), 'utf8'));

const IDENTITY = { deviceId: 'device-test', accountUuid: 'acct-test', sessionId: 'sess-test' };
const TAG = 'x-anthropic-billing-header: cc_version=5.5.25.abc; cc_entrypoint=sdk-cli;';
const build = (body, opts = {}) => buildCCRequest(
  structuredClone(body), TAG, { type: 'ephemeral' }, IDENTITY, opts);

// ======================================================================
header('every new request kind is still recognised as genuine CC');
{
  // The recognition predicate keys on the billing block in system[0] plus the
  // CC identity headers. All four kinds have to clear it, or they fall to the
  // template-rebuild path and get their bodies rewritten. The subagent is the
  // one at risk: its system[1] is the Agent-SDK wording, and the predicate
  // runs detectTextToolClient over exactly that block.
  for (const kind of KINDS) {
    const s = S[kind];
    const sys = s.request.systemBlocks;
    check(`${kind}: billing block first, CC identity headers present`,
      Array.isArray(sys) && sys.length >= 2
      && s.request.billingFields?.cc_version !== undefined
      && /^claude-cli\/\d+\.\d+\.\d+ \(external, /.test(s.request.headers['user-agent'])
      && s.request.headers['x-app'] === 'cli');
  }

  // Reconstructed from the shape rather than the full body: the predicate only
  // reads system[0].text's billing marker and system[1].text.
  const reconstruct = (kind, sys1Text) => ({
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.236.abc; cc_entrypoint=cli;' },
      { type: 'text', text: sys1Text },
    ],
    messages: [],
  });
  const CLI_LINE = "You are Claude Code, Anthropic's official CLI for Claude.";
  const SDK_LINE = "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.";
  const HEADERS = { 'user-agent': 'claude-cli/2.1.236 (external, cli)', 'x-app': 'cli' };

  check('the plain CLI system[1] is recognised',
    isGenuineCCClient(reconstruct('main', CLI_LINE), HEADERS) === true);
  check('the subagent Agent-SDK system[1] is recognised too',
    isGenuineCCClient(reconstruct('sub', SDK_LINE), HEADERS) === true);
}

// ======================================================================
header('subagent: the billing block carries a third field');
{
  const s = S['subagent-dispatch'];
  const fields = s.request.billingFields ?? {};
  check('recorded subagent billing block sets cc_is_subagent=true',
    fields.cc_is_subagent === 'true');
  check('and still says cc_entrypoint=cli, not sdk-cli',
    fields.cc_entrypoint === 'cli');
  check('the main-loop kinds do NOT set cc_is_subagent',
    S['image-tool-result'].request.billingFields?.cc_is_subagent === undefined
    && S['thinking-turn'].request.billingFields?.cc_is_subagent === undefined);

  // dario's own tag has two fields and no subagent notion. That is fine only
  // because the genuine-CC path forwards system[0] verbatim and never stamps
  // its own. If that ever regresses, a subagent request starts billing as a
  // main-loop one.
  const built = build({
    model: 'claude-sonnet-5',
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.236.9ee; cc_entrypoint=cli; cc_is_subagent=true;' },
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK." },
    ],
    messages: [{ role: 'user', content: 'go' }],
  }, { clientHeaders: { 'user-agent': 'claude-cli/2.1.236 (external, cli)', 'x-app': 'cli' } });
  check('buildCCRequest forwards the subagent billing block untouched',
    built.genuineCC === true
    && built.body.system[0].text.includes('cc_is_subagent=true'));
}

// ======================================================================
header('image: the block is nested inside a tool_result, not top level');
{
  const s = S['image-tool-result'];
  const withImage = [];
  s.request.messageShape.forEach((m, mi) => {
    if (!Array.isArray(m.blocks)) return;
    m.blocks.forEach((b, bi) => {
      if (b.nested?.some((n) => n.type === 'image')) withImage.push({ mi, bi, b, role: m.role });
    });
  });

  check('the recording has exactly one image, and it is nested', withImage.length === 1);
  const hit = withImage[0];
  check('its carrier is a tool_result in a user turn',
    hit?.b.type === 'tool_result' && hit?.role === 'user');
  check('the nested block declares a base64 png source',
    hit?.b.nested.some((n) => n.type === 'image' && n.sourceType === 'base64' && n.mediaType === 'image/png'));
  check('no image appears as a TOP-LEVEL content block anywhere',
    s.request.messageShape.every((m) => !Array.isArray(m.blocks) || m.blocks.every((b) => b.type !== 'image')));

  // CC put a breakpoint on the carrier. A rewrite that relocates breakpoints
  // by counting top-level blocks would move it off the image.
  check('CC placed a cache breakpoint on the tool_result carrying the image',
    hit?.b.cacheControl?.type === 'ephemeral');
}

// ======================================================================
header('image: it survives both paths intact');
{
  const nestedImage = {
    type: 'tool_result',
    tool_use_id: 'toolu_img',
    content: [{ type: 'image', source: { type: 'base64', data: 'iVBORw0KGgo=', media_type: 'image/png' } }],
    cache_control: { type: 'ephemeral', ttl: '1h' },
  };
  const body = (extra) => ({
    model: 'claude-sonnet-5',
    max_tokens: 1024,
    messages: [
      { role: 'user', content: 'look' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_img', name: 'Read', input: {} }] },
      { role: 'user', content: [nestedImage] },
    ],
    ...extra,
  });
  const countImages = (msgs) => JSON.stringify(msgs).split('"type":"image"').length - 1;

  // Genuine-CC path: byte-faithful except cache_control retagging.
  const cc = build(body({
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.236.abc; cc_entrypoint=cli;' },
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
    ],
  }), { clientHeaders: { 'user-agent': 'claude-cli/2.1.236 (external, cli)', 'x-app': 'cli' } });
  check('genuine-CC passthrough keeps the nested image', countImages(cc.body.messages) === 1);
  check('and keeps the breakpoint on its carrier',
    cc.body.messages[2].content[0].cache_control?.type === 'ephemeral');
  check('and does not lift the image to the top level',
    cc.body.messages[2].content[0].type === 'tool_result');

  // Template path: a third-party client sending the same content. The strip
  // loop here walks msg.content one level deep and deletes cache_control; the
  // image lives one level below that and must come through untouched.
  const tpl = build(body({}));
  check('template rebuild keeps the nested image too', countImages(tpl.body.messages) === 1);
  const rebuilt = tpl.body.messages.find((m) => Array.isArray(m.content)
    && m.content.some((b) => b.type === 'tool_result'));
  check('the image source survives the rebuild byte-for-byte',
    JSON.stringify(rebuilt?.content?.[0]?.content?.[0]?.source)
      === JSON.stringify(nestedImage.content[0].source));
}

// ======================================================================
header('web search: the shape of a server-tool turn');
{
  const s = S['web-search-server-tool'];
  check('one tool, and it is server-executed',
    s.request.tools?.length === 1 && s.request.tools[0].serverExecuted === true
    && s.request.tools[0].type === 'web_search_20250305');
  check('a server tool carries no input_schema',
    s.request.tools[0].hasInputSchema === false);
  check('it declares max_uses', s.request.tools[0].max_uses === 8);
  check('the turn sends tool_choice and temperature, unlike the main loop',
    s.request.nested.tool_choice !== undefined && s.request.scalars.temperature !== undefined);
  check('thinking is explicitly DISABLED here, unlike every other kind',
    JSON.stringify(s.request.nested.thinking) === '{"type":"disabled"}');
  check('and context_management is absent, because it is paired with thinking',
    s.request.nested.context_management === undefined);
  check('a third system block carries the web-search role instruction',
    Array.isArray(s.request.systemBlocks) && s.request.systemBlocks.length === 3);

  const beta = s.request.headers['anthropic-beta'].split(',');
  check('its beta list drops claude-code-20250219', !beta.includes('claude-code-20250219'));
  check('and drops extended-cache-ttl-2025-04-11', !beta.includes('extended-cache-ttl-2025-04-11'));
  check('while the main-loop kinds keep both',
    S['image-tool-result'].request.headers['anthropic-beta'].includes('claude-code-20250219')
    && S['image-tool-result'].request.headers['anthropic-beta'].includes('extended-cache-ttl-2025-04-11'));

  // The response is the half nothing else in the suite covers: server tools
  // come back as server_tool_use / web_search_tool_result, which a client
  // never executes.
  const events = websearchFull.response.body;
  check('the recorded response carries a server_tool_use block',
    typeof events === 'string' && events.includes('server_tool_use'));
  check('and a web_search_tool_result block',
    typeof events === 'string' && events.includes('web_search_tool_result'));
}

// ======================================================================
header('server tools must never be name-mapped onto client tools');
{
  // A tool with a `type` field is executed by Anthropic's infrastructure. A
  // tool without one is executed by the client. The name-based mapper exists
  // for the second kind, and TOOL_MAP is keyed on lowercase names — which is
  // exactly what server tools have. Three of them collide:
  //
  //   web_search  -> WebSearch     (and the request balloons 1 -> 33 tools)
  //   web_fetch   -> WebFetch      (same)
  //   bash        -> Bash
  //
  // The other four (code_execution, str_replace_based_edit_tool, computer,
  // memory) survived only because their names happen not to collide. The
  // consequence was silent: the client asked for a search Anthropic runs and
  // got back a `tool_use` it was expected to run itself. Fixed by splitting
  // server tools out before the mapper sees them; these hold the split.
  const SERVER_TOOLS = [
    ['web_search_20250305', 'web_search'],
    ['web_fetch_20250910', 'web_fetch'],
    ['code_execution_20250522', 'code_execution'],
    ['bash_20250124', 'bash'],
    ['text_editor_20250728', 'str_replace_based_edit_tool'],
    ['computer_20250124', 'computer'],
    ['memory_20250818', 'memory'],
  ];
  for (const [type, name] of SERVER_TOOLS) {
    const extra = type.startsWith('computer') ? { display_width_px: 1, display_height_px: 1 } : {};
    const r = build({
      model: 'claude-sonnet-5', max_tokens: 512,
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ type, name, ...extra }],
    });
    const out = r.body.tools ?? [];
    check(`${name}: forwarded verbatim with its type intact`,
      out.length === 1 && out[0].type === type && out[0].name === name);
    check(`${name}: not rewritten into a client tool`, r.toolMap.size === 0);
  }
}

// ======================================================================
header('thinking: what the recording shows, and what dario does with it');
{
  const s = S['thinking-turn'];
  check('CC enables thinking by default at budget 31999',
    JSON.stringify(s.request.nested.thinking) === '{"budget_tokens":31999,"type":"enabled"}');
  check('paired with context_management clear_thinking_20251015',
    JSON.stringify(s.request.nested.context_management)
      === '{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]}');
  check('and the assistant history carries thinking blocks',
    s.request.messageShape.some((m) => m.role === 'assistant'
      && Array.isArray(m.blocks) && m.blocks.some((b) => b.type === 'thinking')));

  // The template path strips thinking from history unconditionally. Measured,
  // not assumed: a request with thinking enabled and the blocks stripped was
  // sent through a live proxy to api.anthropic.com and answered 200, so this
  // is a fidelity loss (the model loses its own prior reasoning) and not a
  // protocol violation. Pinned so that if the API ever starts rejecting it,
  // this suite says where to look.
  const withThinking = {
    model: 'claude-sonnet-5', max_tokens: 4096,
    thinking: { type: 'enabled', budget_tokens: 2048 },
    messages: [
      { role: 'user', content: 'read foo' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'I should read it.', signature: 'SIG_ABC' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/foo' } },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'hi' }] },
    ],
    tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object', properties: {} } }],
  };
  const dflt = build(withThinking);
  check('template path strips thinking blocks from assistant history',
    !JSON.stringify(dflt.body.messages).includes('SIG_ABC'));
  check('and substitutes its own adaptive thinking shape',
    JSON.stringify(dflt.body.thinking) === '{"type":"adaptive","display":"omitted"}');

  const honored = build(withThinking, { honorClientThinking: true });
  check('--honor-client-thinking forwards the client thinking config',
    JSON.stringify(honored.body.thinking) === '{"type":"enabled","budget_tokens":2048}');
  check('but the history strip still applies — the two are not coordinated',
    !JSON.stringify(honored.body.messages).includes('SIG_ABC'));

  // Haiku rejects both fields, so they are gated off there. Easy to mistake
  // for "dario drops thinking" when probing with a Haiku model.
  const haiku = build({ ...withThinking, model: 'claude-haiku-4-5-20251001' });
  check('Haiku gets no thinking field at all', haiku.body.thinking === undefined);
  check('and no context_management either', haiku.body.context_management === undefined);

  // Genuine CC keeps everything, including the signed blocks.
  const cc = build({
    ...withThinking,
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.236.abc; cc_entrypoint=cli;' },
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
    ],
  }, { clientHeaders: { 'user-agent': 'claude-cli/2.1.236 (external, cli)', 'x-app': 'cli' } });
  check('genuine-CC passthrough keeps the signed thinking block',
    JSON.stringify(cc.body.messages).includes('SIG_ABC'));
  check('and keeps the client thinking config verbatim',
    JSON.stringify(cc.body.thinking) === '{"type":"enabled","budget_tokens":2048}');
}

console.log(`\n${'='.repeat(70)}\n  ${pass} pass, ${fail} fail\n${'='.repeat(70)}`);
process.exit(fail === 0 ? 0 : 1);
