// Records what api.anthropic.com sends AFTER a mid-stream `error` event.
//
// proxy.ts's abnormal-exit path writes an `error` event and then stops, with no
// synthetic `message_stop` behind it. That choice is deliberate — inventing
// framing upstream never sent is the failure the whole response path exists to
// remove — but it rests on an unverified premise: that api.anthropic.com does
// not send one either. The streaming docs show the error event in isolation and
// say nothing about what follows, other gateways append a `message_stop`, and
// no recording in test/fixtures/ has ever caught a real mid-stream error.
//
// The blocker was never analysis, it was arrival. An `overloaded_error` on an
// already-200 stream happens when Anthropic is busy, which is not a thing that
// can be scheduled, and it is over in milliseconds. So instead of watching for
// one, leave this armed: dario already reassembles every complete upstream SSE
// event to keep analytics, and that is the only hook this needs. When an
// upstream `error` event goes past, everything from that event to the end of
// the stream is written to a file, and the question answers itself.
//
// Off unless DARIO_CAPTURE_MIDSTREAM_ERRORS names a directory. It writes
// upstream bytes to disk, which on a normal stream would include generated
// text — so it is opt-in, it starts recording only at the error event and never
// before it, and it records nothing at all on a healthy stream.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Directory to record into, or null when the capture is disarmed. */
export function captureDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env['DARIO_CAPTURE_MIDSTREAM_ERRORS']?.trim();
  return raw ? raw : null;
}

/**
 * Is this reassembled SSE event an upstream error?
 *
 * Matches on the parsed payload rather than the `event:` line: the type is what
 * the API contract names, and an event line is optional in SSE. A payload that
 * does not parse is not an error event — it is a chunk boundary this function
 * was handed too early, and guessing from a substring would fire on any
 * generated text containing the word.
 */
export function isUpstreamErrorEvent(part: string): boolean {
  const dataLine = part.split('\n').find((l) => l.startsWith('data: '));
  if (!dataLine) return false;
  try {
    return (JSON.parse(dataLine.slice(6)) as { type?: unknown }).type === 'error';
  } catch {
    return false;
  }
}

/** One recording, opened on the error event and appended to until the stream ends. */
export interface MidstreamCapture {
  /** Record one further upstream event. */
  event: (part: string) => void;
  /** Note how the stream finished and close the record. */
  finish: (note: string) => void;
  /** Where it was written. */
  readonly path: string;
}

/**
 * Begin a recording. `precedingEvents` is the count of events already seen on
 * this stream, which is what makes an error MID-stream rather than the whole
 * response: an error as the very first event is an ordinary error the client
 * would have got from a direct call, and is not the case under question.
 */
export function beginCapture(
  dir: string,
  errorEvent: string,
  meta: { requestId: string; model: string; precedingEvents: number },
  now: number,
): MidstreamCapture | null {
  if (meta.precedingEvents === 0) return null;
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return null;  // an unwritable capture dir must never take the stream down
  }
  const path = join(dir, `midstream-error-${now}-${meta.requestId || 'unknown'}.sse`);
  const write = (s: string): void => { try { appendFileSync(path, s); } catch { /* never fatal */ } };
  write(`# dario mid-stream error capture\n`
    + `# model: ${meta.model}\n`
    + `# request-id: ${meta.requestId}\n`
    + `# upstream events before the error: ${meta.precedingEvents}\n`
    + `# everything below is upstream's, verbatim, starting at the error event.\n`
    + `# THE QUESTION: does a message_stop appear after the error event?\n\n`);
  write(`${errorEvent}\n\n`);
  return {
    path,
    event: (part) => write(`${part}\n\n`),
    finish: (note) => write(`# stream ended: ${note}\n`),
  };
}
