#!/usr/bin/env bun

import {
  boundPreview,
  extractRequestPreview,
  extractResponsePreview,
  redactPreviewText,
  StreamingTextPreview,
} from '../dist/request-preview.js';

let pass = 0;
let fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const request = extractRequestPreview({
  system: 'You are Claude Code.',
  messages: [
    { role: 'user', content: 'inspect the routing logs' },
    { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/log' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'request completed' }] },
  ],
});
check('request preview includes system identity', request.text.includes('Claude Code'));
check('request preview includes user words', request.text.includes('routing logs'));
check('request preview includes tool activity', request.text.includes('[tool_use Read]'));
check('request preview identifies tool results without persisting content', request.text.includes('[tool_result tool-1] (content omitted)') && !request.text.includes('request completed'));

const response = extractResponsePreview({
  content: [{ type: 'text', text: 'The round robin is healthy.' }, { type: 'tool_use', name: 'Bash', input: { command: 'true' } }],
});
check('response preview includes output words', response.text.includes('round robin is healthy'));
check('response preview includes output tool call', response.text.includes('[tool_use Bash]'));
const secrets = redactPreviewText('sk-proj-12345678901234567890 ghp_12345678901234567890 password=super-secret');
check('common provider keys are redacted', !secrets.includes('sk-proj-') && !secrets.includes('ghp_'));
check('credential assignments are redacted', secrets.includes('password=[REDACTED]'));

const oversized = boundPreview(`BEGIN-${'x'.repeat(2000)}-END`, 300);
check('oversized preview is bounded', oversized.text.length <= 300, `${oversized.text.length}`);
check('oversized preview retains the beginning', oversized.text.startsWith('BEGIN-'));
check('oversized preview retains the end', oversized.text.endsWith('-END'));
check('oversized preview reports original size', oversized.chars > oversized.text.length && oversized.truncated);

const stream = new StreamingTextPreview(256);
for (const delta of ['Hello', ' world', ', this', ' is streamed output.']) stream.append(delta);
const streamed = stream.preview();
check('stream deltas preserve boundary whitespace', streamed.text === 'Hello world, this is streamed output.', streamed.text);

const longStream = new StreamingTextPreview(256);
longStream.append(`FIRST-${'a'.repeat(800)}`);
longStream.append(`${'b'.repeat(800)}-LAST`);
const longPreview = longStream.preview();
check('long stream stays bounded', longPreview.text.length <= 256, `${longPreview.text.length}`);
check('long stream retains both ends', longPreview.text.startsWith('FIRST-') && longPreview.text.endsWith('-LAST'));
check('long stream reports truncation', longPreview.truncated && longPreview.chars === 1611);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
