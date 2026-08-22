#!/usr/bin/env bun
/**
 * The rig that will settle the message_stop question, exercised against a
 * synthetic mid-stream error.
 *
 * proxy.ts's abnormal-exit path writes an `error` event and stops, with no
 * synthetic `message_stop` behind it, and the long comment there says plainly
 * that whether api.anthropic.com sends one of its own is UNVERIFIED — the
 * streaming docs show the error event in isolation, other gateways append one,
 * and no fixture has ever caught a real one.
 *
 * It cannot be caught on demand. An `overloaded_error` on an already-200 stream
 * arrives when Anthropic is busy, which is not schedulable, and it is over in
 * milliseconds. So the answer is to be armed rather than watching:
 * DARIO_CAPTURE_MIDSTREAM_ERRORS writes everything from an upstream `error`
 * event to the end of that stream into a file, using the SSE reassembly dario
 * already does for analytics. Whenever the next one lands, the file says
 * whether a message_stop followed.
 *
 * What this file checks is the rig, since the event it is waiting for cannot be
 * conjured: a synthetic upstream error mid-stream produces a recording, the
 * recording contains what came after, an error as the FIRST event is not
 * recorded (that is an ordinary error, not the case in question), and a healthy
 * stream writes nothing at all. The last one matters most — the capture reads
 * upstream bytes, so a healthy stream leaking generated text to disk would make
 * this rig worse than the question it answers.
 */

import { rmSync, existsSync, readdirSync, readFileSync, mkdtempSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra !== undefined ? ` — ${extra}` : ''}`); }
}
function header(n) { console.log(`\n${'='.repeat(70)}\n  ${n}\n${'='.repeat(70)}`); }

const home = await mkdtemp(join(tmpdir(), 'dario-midstream-'));
process.on('exit', () => rmSync(home, { recursive: true, force: true }));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DARIO_IGNORE_CC_CREDENTIALS = '1';

const accountsDir = join(home, '.dario', 'accounts');
await mkdir(accountsDir, { recursive: true });
await writeFile(join(accountsDir, 'solo.json'), JSON.stringify({
  alias: 'solo', accessToken: 'token-solo', refreshToken: 'refresh-solo',
  expiresAt: Date.now() + 8 * 60 * 60_000, scopes: ['user:inference'],
  deviceId: 'device-solo', accountUuid: 'account-solo',
}));

const { startProxy } = await import('../dist/proxy.js');

/** An SSE body, as upstream would send it. */
function sseBody(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

const HEALTHY = [
  { type: 'message_start', message: { usage: { input_tokens: 3 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
];

// An overloaded_error arriving mid-stream, with a message_stop behind it — the
// shape under question. The rig must record BOTH so the file can answer either
// way; it takes no view on which is correct.
const ERROR_MIDSTREAM = [
  HEALTHY[0], HEALTHY[1], HEALTHY[2],
  { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
  { type: 'message_stop' },
];

const ERROR_FIRST = [
  { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
];

async function run(events, captureTo) {
  if (captureTo) process.env.DARIO_CAPTURE_MIDSTREAM_ERRORS = captureTo;
  else delete process.env.DARIO_CAPTURE_MIDSTREAM_ERRORS;
  const proxy = await startProxy({
    port: 0, host: '127.0.0.1', noLiveCapture: true,
    fetchImpl: async (url) => {
      if (String(url).includes('/v1/messages')) {
        return new Response(sseBody(events), {
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'request-id': 'req_fake_mid_1' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const res = await fetch(`${proxy.url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'dario', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const text = await res.text();
  await proxy.close();
  return text;
}

function captures(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith('midstream-error-'));
}

header('a mid-stream upstream error is recorded, with everything after it');
{
  const dir = mkdtempSync(join(tmpdir(), 'dario-capture-'));
  await run(ERROR_MIDSTREAM, dir);
  const files = captures(dir);
  check('exactly one recording was written', files.length === 1, JSON.stringify(files));
  if (files.length === 1) {
    const body = readFileSync(join(dir, files[0]), 'utf-8');
    check('it names the question it exists to answer', /THE QUESTION/.test(body));
    check('it records how many events preceded the error',
      /upstream events before the error: 3/.test(body),
      /upstream events before the error: \d+/.exec(body)?.[0]);
    check('it carries the error event itself', /"type":"error"/.test(body));
    // The whole point: what followed the error is on disk, so a real capture
    // answers the question without anyone having been watching.
    check('it carries what upstream sent AFTER the error', /"type":"message_stop"/.test(body));
    check('it notes how the stream ended', /# stream ended:/.test(body));
  }
  rmSync(dir, { recursive: true, force: true });
}

header('an error as the FIRST event is not a mid-stream error');
{
  const dir = mkdtempSync(join(tmpdir(), 'dario-capture-'));
  await run(ERROR_FIRST, dir);
  // A stream whose first event is an error is an ordinary error the client
  // would have seen from a direct call. Recording it would bury the rare case
  // this rig exists for under the common one.
  check('nothing was recorded', captures(dir).length === 0, JSON.stringify(captures(dir)));
  rmSync(dir, { recursive: true, force: true });
}

header('a healthy stream records nothing');
{
  const dir = mkdtempSync(join(tmpdir(), 'dario-capture-'));
  await run(HEALTHY, dir);
  // The capture writes upstream bytes to disk. On a healthy stream those are
  // the user's generated text, and writing them would make this rig a worse
  // problem than the question it answers.
  check('no recording, and no generated text on disk', captures(dir).length === 0,
    JSON.stringify(captures(dir)));
  rmSync(dir, { recursive: true, force: true });
}

header('disarmed by default');
{
  const dir = mkdtempSync(join(tmpdir(), 'dario-capture-'));
  await run(ERROR_MIDSTREAM, null);
  check('a mid-stream error writes nothing when the env var is unset',
    captures(dir).length === 0, JSON.stringify(captures(dir)));
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
