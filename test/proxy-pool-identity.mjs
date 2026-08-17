#!/usr/bin/env bun

import { rewritePoolIdentity } from '../dist/proxy.js';

let pass = 0;
let fail = 0;
function check(label, condition) {
  if (condition) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`); }
}

const original = Buffer.from(JSON.stringify({
  model: 'claude-sonnet-4-6',
  metadata: {
    user_id: JSON.stringify({
      device_id: 'old-device',
      account_uuid: 'old-account',
      session_id: 'old-session',
      retained: 'value',
    }),
  },
  messages: [{ role: 'user', content: 'hello' }],
}));

const rewritten = rewritePoolIdentity(original, {
  deviceId: 'new-device',
  accountUuid: 'new-account',
  sessionId: 'new-session',
});
const parsed = JSON.parse(rewritten.toString('utf8'));
const identity = JSON.parse(parsed.metadata.user_id);

check('device id follows the failover account', identity.device_id === 'new-device');
check('account id follows the failover account', identity.account_uuid === 'new-account');
check('body session follows the failover header session', identity.session_id === 'new-session');
check('unrelated identity metadata survives', identity.retained === 'value');
check('request content survives', parsed.messages[0].content === 'hello');

const opaque = Buffer.from('not-json');
check('opaque bodies are unchanged', rewritePoolIdentity(opaque, {
  deviceId: 'device', accountUuid: 'account', sessionId: 'session',
}) === opaque);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
