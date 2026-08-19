// The round-robin fallback arm, and the fact that it is mostly dead.
//
// buildCCRequest resolves an unmapped client tool onto a CC "fallback slot",
// chosen from CC_FALLBACK_TOOLS with the tools the client already claimed
// filtered OUT so two client names never collide on one CC tool. The advertise
// path emits only the tools the client DID declare. On an ordinary client
// those two sets are exact complements, so the slot the arm picks is never in
// the outgoing tools array — the model is not offered it and cannot call it.
//
// The mapping is not inert, though, and this is the part that had gone
// unrecorded: the history remap runs regardless of what is advertised, so a
// past tool_use for the client's tool is renamed onto the absent slot and its
// input is replaced by translateArgs. `unreachableTools` reports both losses.
//
// Deliberately NOT asserted: that the slot gets advertised. Making the rename
// land means advertising a CC tool the client never declared, which is the
// failure e409f52 exists to prevent ("<Tool> exists but is not enabled in this
// context"). One path, two client classes, opposite requirements — the
// resolution taken is to report the loss, not to hide or "fix" it.

import { buildCCRequest } from '../dist/cc-template.js';

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);

const identity = { deviceId: 'd', accountUuid: 'a', sessionId: 's' };
const build = (body, opts = {}) => buildCCRequest(structuredClone(body), 'tag', undefined, identity, opts);
const names = (r) => (r.body.tools ?? []).map((t) => t.name);

const mixedClient = {
  model: 'claude-sonnet-5', max_tokens: 64,
  tools: [
    { name: 'Read', description: 'r', input_schema: { type: 'object' } },
    { name: 'Bash', description: 'b', input_schema: { type: 'object' } },
    { name: 'memory_get', description: 'unmapped', input_schema: { type: 'object' } },
  ],
  messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'memory_get', input: { key: 'user_prefs' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] },
    { role: 'user', content: 'hi' },
  ],
};

header('a mixed client: the assigned slot is never advertised');
{
  const r = build(mixedClient);
  const advertised = names(r);
  const slot = r.toolMap.get('memory_get')?.ccTool;
  check('the unmapped tool is recorded as unmapped', r.unmappedTools.includes('memory_get'));
  check('it still gets a fallback slot', typeof slot === 'string' && slot.length > 0, String(slot));
  check('the slot avoids tools the client claimed', slot !== 'Read' && slot !== 'Bash', slot);
  check('…which is exactly why it is not advertised', !advertised.includes(slot),
    `slot ${slot} vs advertised ${JSON.stringify(advertised)}`);
  check('only the client-declared natives go out', JSON.stringify(advertised) === JSON.stringify(['Bash', 'Read']),
    JSON.stringify(advertised));
  check('and it is reported as unreachable', r.unreachableTools.includes('memory_get'),
    JSON.stringify(r.unreachableTools));
}

header('history is rewritten onto the absent slot anyway');
{
  const r = build(mixedClient);
  const slot = r.toolMap.get('memory_get')?.ccTool;
  const block = r.body.messages[0].content[0];
  check('the history tool_use is renamed', block.name === slot, `${block.name} vs ${slot}`);
  check('…onto a name the request does not advertise', !names(r).includes(block.name));
  check('the original argument does not survive', !('key' in block.input), JSON.stringify(block.input));
  check('translateArgs substituted the slot shape', JSON.stringify(block.input) === JSON.stringify({ pattern: '.', path: '.' }),
    JSON.stringify(block.input));
}

header('a client of nothing but unmapped tools never reaches the arm');
{
  // Auto-detection classifies this as non-CC and forwards the schemas
  // verbatim, which is the right answer and means the round-robin is not
  // consulted at all. Worth pinning: it bounds how often the arm can matter.
  const r = build({
    model: 'claude-sonnet-5', max_tokens: 64,
    tools: [{ name: 'memory_get', description: 'unmapped', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'hi' }],
  });
  check('detected as non-CC', r.detectedClient === 'unknown-non-cc', String(r.detectedClient));
  check('schemas forwarded verbatim', JSON.stringify(names(r)) === JSON.stringify(['memory_get']), JSON.stringify(names(r)));
  check('no fallback slot assigned', r.toolMap.get('memory_get') === undefined);
  check('nothing unreachable', r.unreachableTools.length === 0);
}

header('the arm works where the whole template is sent');
{
  // Same client with detection off: no CC-native declared, so the advertise
  // branch falls back to the whole template. Every fallback slot IS advertised
  // there, so the mapping is genuinely reachable — which is why unreachability
  // is computed against the finalized array rather than assumed.
  const r = build({
    model: 'claude-sonnet-5', max_tokens: 64,
    tools: [{ name: 'memory_get', description: 'unmapped', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'hi' }],
  }, { noAutoDetect: true });
  const slot = r.toolMap.get('memory_get')?.ccTool;
  check('full template advertised', names(r).length > 10, String(names(r).length));
  check('the slot is advertised here', names(r).includes(slot), String(slot));
  check('so nothing is reported unreachable', r.unreachableTools.length === 0,
    JSON.stringify(r.unreachableTools));
}

header('hybrid mode drops instead of assigning, so nothing is unreachable');
{
  const r = build(mixedClient, { hybridTools: true });
  check('still counted as unmapped', r.unmappedTools.includes('memory_get'));
  check('but no fallback slot is assigned', r.toolMap.get('memory_get') === undefined);
  check('and nothing is reported unreachable', r.unreachableTools.length === 0,
    JSON.stringify(r.unreachableTools));
}

header('preserve-tools forwards verbatim, so the question does not arise');
{
  const r = build(mixedClient, { preserveTools: true });
  check('no unmapped tools', r.unmappedTools.length === 0, JSON.stringify(r.unmappedTools));
  check('no unreachable tools', r.unreachableTools.length === 0, JSON.stringify(r.unreachableTools));
  const block = r.body.messages[0].content[0];
  check('history is left alone', block.name === 'memory_get' && block.input.key === 'user_prefs',
    `${block.name} ${JSON.stringify(block.input)}`);
}

header('a client declaring every fallback still gets a slot');
{
  const all = ['Bash', 'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'];
  const r = build({
    model: 'claude-sonnet-5', max_tokens: 64,
    tools: [...all.map((n) => ({ name: n, description: n, input_schema: { type: 'object' } })),
      { name: 'memory_get', description: 'unmapped', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'hi' }],
  });
  const slot = r.toolMap.get('memory_get')?.ccTool;
  // Every fallback is claimed, so the pool falls back to the full list and the
  // slot collides with a tool the client DID declare — which means it is
  // advertised, and the arm is reachable, at the cost of the ambiguity the
  // filter normally avoids.
  check('a slot is still assigned', all.includes(slot), String(slot));
  check('it is advertised, because the client declared it', names(r).includes(slot));
  check('so it is not reported unreachable', !r.unreachableTools.includes('memory_get'),
    JSON.stringify(r.unreachableTools));
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
