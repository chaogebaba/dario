#!/usr/bin/env bun
// Pure session-affinity identity extraction. No proxy, OAuth, or network.

import { extractSessionAffinityKey } from '../dist/session-affinity.js';

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
    }, body) === 'codex:codex-session');
  check('underscore Codex header is accepted',
    extractSessionAffinityKey({ session_id: 'codex-underscore' }, body) === 'codex:codex-underscore');
  check('header lookup is case-insensitive and accepts arrays',
    extractSessionAffinityKey({ 'X-SESSION-ID': ['', ' session-two '] }, body) === 'header:session-two');
  check('OpenCode affinity header is accepted',
    extractSessionAffinityKey({ 'x-session-affinity': 'open-code' }, body) === 'affinity:open-code');
  check('Amp thread id is accepted',
    extractSessionAffinityKey({ 'x-amp-thread-id': 'amp-session' }, body) === 'amp:amp-session');
  check('dario client session header is accepted',
    extractSessionAffinityKey({ 'x-client-session-id': 'client-session' }, body) === 'client-session:client-session');
  check('stable body identity wins over a per-request id',
    extractSessionAffinityKey({ 'x-client-request-id': 'request-one' }, body) === 'session:body-session');
  check('client request id is only used when no stable body identity exists',
    extractSessionAffinityKey({ 'x-client-request-id': 'request-session' }, {}) === 'client-request:request-session');
  check('client request id precedes the message-hash fallback',
    extractSessionAffinityKey({ 'x-client-request-id': 'request-session' }, {
      messages: [{ role: 'user', content: 'a message that can be hashed' }],
    }) === 'client-request:request-session');
  check('Headers objects are supported',
    extractSessionAffinityKey(new Headers({ 'x-session-id': 'headers-object' }), body) === 'header:headers-object');
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
  check('prompt cache key precedes conversation id',
    extractSessionAffinityKey({}, {
      prompt_cache_key: 'cache-key', conversation: { id: 'conversation-id' },
    }) === 'prompt-cache:cache-key');
  check('conversation object id is accepted',
    extractSessionAffinityKey({}, { conversation: { id: 'conversation-id' } }) === 'conversation:conversation-id');
  check('conversation string is accepted',
    extractSessionAffinityKey({}, { conversation: 'conversation-string' }) === 'conversation:conversation-string');
  check('legacy metadata user_id is accepted',
    extractSessionAffinityKey({}, { metadata: { user_id: 'legacy-user' } }) === 'user:legacy-user');
  check('legacy conversation_id is accepted',
    extractSessionAffinityKey({}, { conversation_id: 'legacy-conversation' }) === 'conversation:legacy-conversation');
}

header('first-user-message hash fallback');
{
  const stringBody = { messages: [{ role: 'user', content: '  same prompt  ' }] };
  const stringKey = extractSessionAffinityKey({}, stringBody);
  check('string content produces a fixed-width hash key', /^message:[0-9a-f]{16}$/.test(stringKey ?? ''));
  check('trimmed-equivalent content is stable',
    stringKey === extractSessionAffinityKey({}, { messages: [{ role: 'user', content: 'same prompt' }] }));
  check('different first messages produce different keys',
    stringKey !== extractSessionAffinityKey({}, { messages: [{ role: 'user', content: 'different prompt' }] }));

  const reminder = '<system-reminder>shared bootstrap</system-reminder>';
  const conversationA = { messages: [{ role: 'user', content: [
    { type: 'text', text: reminder }, { type: 'text', text: 'actual prompt A' },
  ] }] };
  const conversationB = { messages: [{ role: 'user', content: [
    { type: 'text', text: reminder }, { type: 'text', text: 'actual prompt B' },
  ] }] };
  check('all text blocks contribute, so shared reminders do not collapse sessions',
    extractSessionAffinityKey({}, conversationA) !== extractSessionAffinityKey({}, conversationB));
  check('non-text blocks do not perturb the key',
    extractSessionAffinityKey({}, conversationA) === extractSessionAffinityKey({}, {
      messages: [{ role: 'user', content: [
        { type: 'text', text: reminder }, { type: 'image', source: 'ignored' }, { type: 'text', text: 'actual prompt A' },
      ] }],
    }));
  check('missing usable identity returns null', extractSessionAffinityKey({}, { messages: [] }) === null);
}

console.log(`\n${'='.repeat(70)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(70)}`);
process.exit(fail > 0 ? 1 : 0);
