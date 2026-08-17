#!/usr/bin/env bun
// Pure session-affinity identity extraction. No proxy, OAuth, or network.

import { extractSessionAffinityKey, extractSessionAffinitySignals } from '../dist/session-affinity.js';

let pass = 0;
let fail = 0;
function check(label, condition) {
  if (condition) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
}
function header(label) {
  console.log(`\n${'='.repeat(70)}\n  ${label}\n${'='.repeat(70)}`);
}

header('explicit header priority and normalization');
{
  const body = { session_id: 'body-session', messages: [{ role: 'user', content: 'hello' }] };
  check('Claude Code header wins over every lower-priority signal',
    extractSessionAffinityKey({
      'X-Claude-Code-Session-ID': '  claude-session  ',
      'session-id': 'codex-session',
      'x-session-id': 'generic-session',
    }, body) === 'claude:claude-session');
  check('Codex Session-Id precedes generic session headers',
    extractSessionAffinityKey({
      'session-id': 'codex-session',
      'x-session-id': 'generic-session',
    }, body) === 'session:codex-session');
  check('underscore Codex header is accepted',
    extractSessionAffinityKey({ session_id: 'codex-underscore' }, body) === 'session:codex-underscore');
  check('header lookup is case-insensitive and accepts arrays',
    extractSessionAffinityKey({ 'X-SESSION-ID': ['', ' session-two '] }, body) === 'session:session-two');
  check('OpenCode affinity header is accepted',
    extractSessionAffinityKey({ 'x-session-affinity': 'open-code' }, body) === 'affinity:open-code');
  check('Amp thread id is accepted',
    extractSessionAffinityKey({ 'x-amp-thread-id': 'amp-session' }, body) === 'amp:amp-session');
  check('dario client session header is accepted',
    extractSessionAffinityKey({ 'x-client-session-id': 'client-session' }, body) === 'session:client-session');
  check('stable body identity wins over a per-request id',
    extractSessionAffinityKey({ 'x-client-request-id': 'request-one' }, body) === 'session:body-session');
  check('client request id alone does not create a binding',
    extractSessionAffinityKey({ 'x-client-request-id': 'request-session' }, {}) === null);
  check('client request id remains diagnostic beside a message fallback',
    extractSessionAffinityKey({ 'x-client-request-id': 'request-session' }, {
      messages: [{ role: 'user', content: 'a message that can be hashed' }],
    }) === null);
  check('Headers objects are supported',
    extractSessionAffinityKey(new Headers({ 'x-session-id': 'headers-object' }), body) === 'session:headers-object');
}

header('invalid explicit identifiers fall through');
{
  check('control characters are rejected',
    extractSessionAffinityKey({ 'x-session-id': 'bad\nvalue' }, { session_id: 'body' }) === 'session:body');
  check('oversized identifiers are rejected',
    extractSessionAffinityKey({ 'x-session-id': 'x'.repeat(513) }, { session_id: 'body' }) === 'session:body');
  check('blank identifiers are rejected',
    extractSessionAffinityKey({ 'x-session-id': '   ' }, { session_id: 'body' }) === 'session:body');
}

header('body identifiers');
{
  check('top-level session_id is preferred',
    extractSessionAffinityKey({}, { session_id: 'snake', sessionId: 'camel' }) === 'session:snake');
  check('top-level sessionId is accepted',
    extractSessionAffinityKey({}, { sessionId: 'camel' }) === 'session:camel');
  check('Claude metadata JSON extracts only its session id',
    extractSessionAffinityKey({}, {
      metadata: { user_id: JSON.stringify({ device_id: 'device', account_uuid: 'account', session_id: 'claude-body' }) },
    }) === 'claude:claude-body');
  check('Claude metadata object is accepted',
    extractSessionAffinityKey({}, { metadata: { user_id: { sessionId: 'claude-object' } } }) === 'claude:claude-object');
  check('legacy Claude metadata suffix is accepted',
    extractSessionAffinityKey({}, { metadata: { user_id: 'user_x_account_y_session_legacy-id' } }) === 'claude:legacy-id');
  check('native Claude metadata wins over a conflicting coarse header',
    extractSessionAffinityKey({ 'x-amp-thread-id': 'amp-session' }, {
      metadata: { user_id: JSON.stringify({ session_id: 'claude-body' }) },
    }) === 'claude:claude-body');
  check('conversation id precedes prompt cache metadata',
    extractSessionAffinityKey({}, {
      prompt_cache_key: 'cache-key', conversation: { id: 'conversation-id' },
    }) === 'conversation:conversation-id');
  check('conversation id remains stable when prompt cache metadata appears later',
    extractSessionAffinityKey({}, { conversation: { id: 'conversation-id' } })
      === extractSessionAffinityKey({}, {
        prompt_cache_key: 'cache-key', conversation: { id: 'conversation-id' },
      }));
  check('conversation object id is accepted',
    extractSessionAffinityKey({}, { conversation: { id: 'conversation-id' } }) === 'conversation:conversation-id');
  check('conversation string is accepted',
    extractSessionAffinityKey({}, { conversation: 'conversation-string' }) === 'conversation:conversation-string');
  check('legacy metadata user_id is diagnostic-only',
    extractSessionAffinityKey({}, { metadata: { user_id: 'legacy-user' } }) === null);
  check('legacy conversation_id is accepted',
    extractSessionAffinityKey({}, { conversation_id: 'legacy-conversation' }) === 'conversation:legacy-conversation');
  const signals = extractSessionAffinitySignals({ 'x-claude-code-session-id': 'header-session' }, {
    metadata: { user_id: JSON.stringify({ session_id: 'body-session' }) },
    prompt_cache_key: 'cache-session',
    messages: [{ role: 'user', content: 'hello' }],
  });
  check('provenance lists header before body candidates',
    signals[0]?.source === 'header:x-claude-code-session-id' && signals[0]?.key === 'claude:header-session'
      && signals.some((signal) => signal.source === 'body:metadata.user_id.session_id' && signal.key === 'claude:body-session'));
  check('provenance marks prompt-cache and bounded message signals diagnostic-only',
    signals.some((signal) => signal.source === 'body:prompt_cache_key' && !signal.bindingEligible)
      && signals.some((signal) => signal.source === 'fallback:first-user-message' && !signal.bindingEligible));
  check('structured Claude metadata is not duplicated as a legacy user signal',
    !signals.some((signal) => signal.source === 'body:metadata.user_id'));
  check('camel-case Claude metadata has exact provenance',
    extractSessionAffinitySignals({}, { metadata: { user_id: { sessionId: 'camel' } } })[0]?.source
      === 'body:metadata.user_id.sessionId');
  check('legacy Claude metadata suffix has exact provenance',
    extractSessionAffinitySignals({}, { metadata: { user_id: 'user_x_session_legacy' } })[0]?.source
      === 'body:metadata.user_id.legacy-session-suffix');
}

header('diagnostic-only fallback signals');
{
  const stringBody = { messages: [{ role: 'user', content: '  same prompt  ' }] };
  const messageSignal = extractSessionAffinitySignals({}, stringBody)
    .find((signal) => signal.source === 'fallback:first-user-message');
  check('string content produces a fixed-width diagnostic hash',
    /^message:[0-9a-f]{16}$/.test(messageSignal?.key ?? '') && !messageSignal?.bindingEligible);
  check('message hash never creates an affinity binding', extractSessionAffinityKey({}, stringBody) === null);
  check('two fresh identity-less hi sessions do not share a binding',
    extractSessionAffinityKey({}, { messages: [{ role: 'user', content: 'hi' }] }) === null
      && extractSessionAffinityKey({}, { messages: [{ role: 'user', content: 'hi' }] }) === null);
  check('prompt-cache key alone does not create an affinity binding',
    extractSessionAffinityKey({}, { prompt_cache_key: 'shared-prefix' }) === null);

  const reminder = '<system-reminder>shared bootstrap</system-reminder>';
  const conversationA = { messages: [{ role: 'user', content: [
    { type: 'text', text: reminder }, { type: 'text', text: 'actual prompt A' },
  ] }] };
  const conversationB = { messages: [{ role: 'user', content: [
    { type: 'text', text: reminder }, { type: 'text', text: 'actual prompt B' },
  ] }] };
  const diagnosticKey = (body) => extractSessionAffinitySignals({}, body)
    .find((signal) => signal.source === 'fallback:first-user-message')?.key;
  check('all text blocks contribute to diagnostic fingerprints',
    diagnosticKey(conversationA) !== diagnosticKey(conversationB));
  check('non-text blocks do not perturb the diagnostic fingerprint',
    diagnosticKey(conversationA) === diagnosticKey({
      messages: [{ role: 'user', content: [
        { type: 'text', text: reminder }, { type: 'image', source: 'ignored' }, { type: 'text', text: 'actual prompt A' },
      ] }],
    }));
  check('missing usable identity returns null', extractSessionAffinityKey({}, { messages: [] }) === null);
}

header('identity continuity and source transitions');
{
  const body = { metadata: { user_id: JSON.stringify({ session_id: 'session-a' }) } };
  check('matching Claude header and body normalize to one key',
    extractSessionAffinityKey({ 'x-claude-code-session-id': 'session-a' }, body)
      === extractSessionAffinityKey({}, body));
  check('a disappearing matching header preserves body identity',
    extractSessionAffinityKey({ 'x-claude-code-session-id': 'session-a' }, body) === 'claude:session-a'
      && extractSessionAffinityKey({}, body) === 'claude:session-a');
  check('conflicting Claude header and body remain distinguishable',
    extractSessionAffinityKey({ 'x-claude-code-session-id': 'header-session' }, body) === 'claude:header-session'
      && extractSessionAffinityKey({}, body) === 'claude:session-a');
  check('later prompt-cache metadata does not replace a conversation binding',
    extractSessionAffinityKey({}, { conversation_id: 'conversation-a' })
      === extractSessionAffinityKey({}, { conversation_id: 'conversation-a', prompt_cache_key: 'shared-prefix' }));
  check('generic header and body forms normalize to the same key',
    extractSessionAffinityKey({ 'session-id': 'generic-a' }, {})
      === extractSessionAffinityKey({}, { session_id: 'generic-a' }));
  check('generic x-session header and camel-case body preserve continuity',
    extractSessionAffinityKey({ 'x-session-id': 'generic-b' }, {})
      === extractSessionAffinityKey({}, { sessionId: 'generic-b' }));
}

header('diagnostic hashing bounds');
{
  const prefix = 'x'.repeat(16_384);
  const first = extractSessionAffinitySignals({}, {
    messages: [{ role: 'user', content: `${prefix}first-tail` }],
  }).find((signal) => signal.source === 'fallback:first-user-message')?.key;
  const second = extractSessionAffinitySignals({}, {
    messages: [{ role: 'user', content: `${prefix}second-tail` }],
  }).find((signal) => signal.source === 'fallback:first-user-message')?.key;
  check('diagnostic hash input is bounded', first === second);
  check('stable identity retains a bounded comparison fingerprint',
    extractSessionAffinitySignals({ 'x-session-id': 'stable' }, {
      messages: [{ role: 'user', content: 'x'.repeat(1_000_000) }],
    }).some((signal) => signal.source === 'fallback:first-user-message' && !signal.bindingEligible));
}

console.log(`\n${'='.repeat(70)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(70)}`);
process.exit(fail > 0 ? 1 : 0);
