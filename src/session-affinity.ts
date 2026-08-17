import { createHash } from 'node:crypto';

export type SessionAffinityHeaders =
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null };

const MAX_EXPLICIT_ID_LENGTH = 512;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 16_384;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function normalizeExplicitId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized.length > MAX_EXPLICIT_ID_LENGTH
    || CONTROL_CHARACTERS.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function headerValue(headers: SessionAffinityHeaders | undefined, name: string): string | null {
  if (!headers) return null;
  if ('get' in headers && typeof headers.get === 'function') {
    return normalizeExplicitId(headers.get(name));
  }

  const wanted = name.toLowerCase();
  for (const [key, raw] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) {
        const normalized = normalizeExplicitId(value);
        if (normalized) return normalized;
      }
      return null;
    }
    return normalizeExplicitId(raw);
  }
  return null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function namespaced(namespace: string, value: unknown): string | null {
  const normalized = normalizeExplicitId(value);
  return normalized ? `${namespace}:${normalized}` : null;
}

function claudeMetadataSessionSignal(body: Record<string, unknown>): ClaudeMetadataSessionSignal | null {
  const metadata = objectValue(body.metadata);
  if (!metadata) return null;

  const rawUserId = metadata.user_id;
  let identity = objectValue(rawUserId);
  if (!identity && typeof rawUserId === 'string') {
    try {
      identity = objectValue(JSON.parse(rawUserId));
    } catch { /* legacy non-JSON identity; inspect its suffix below */ }
    // Older Claude clients encoded the session as a suffix in user_id.
    if (!identity) {
      const marker = rawUserId.lastIndexOf('_session_');
      if (marker >= 0) {
        const key = namespaced('claude', rawUserId.slice(marker + 9));
        return key ? { source: 'body:metadata.user_id.legacy-session-suffix', key } : null;
      }
    }
  }
  if (!identity) return null;
  const snakeCase = namespaced('claude', identity.session_id);
  if (snakeCase) return { source: 'body:metadata.user_id.session_id', key: snakeCase };
  const camelCase = namespaced('claude', identity.sessionId);
  return camelCase ? { source: 'body:metadata.user_id.sessionId', key: camelCase } : null;
}

function conversationId(body: Record<string, unknown>): string | null {
  const conversation = body.conversation;
  if (typeof conversation === 'string') return namespaced('conversation', conversation);
  const record = objectValue(conversation);
  return record ? namespaced('conversation', record.id) : null;
}

function firstUserMessage(body: Record<string, unknown>): string | null {
  if (!Array.isArray(body.messages)) return null;
  const message = body.messages.find((candidate) => objectValue(candidate)?.role === 'user');
  const record = objectValue(message);
  if (!record) return null;

  if (typeof record.content === 'string') {
    const content = record.content.trim();
    return content.length > 0 ? content.slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH) : null;
  }
  if (!Array.isArray(record.content)) return null;

  let remaining = MAX_DIAGNOSTIC_MESSAGE_LENGTH;
  const parts: string[] = [];
  for (const part of record.content) {
    const block = objectValue(part);
    if (block?.type !== 'text' || typeof block.text !== 'string' || block.text.length === 0) continue;
    const text = block.text.slice(0, remaining);
    parts.push(text);
    remaining -= text.length;
    if (remaining === 0) break;
  }
  const text = parts.join('\n').trim();
  return text.length > 0 ? text : null;
}

function messageHash(body: Record<string, unknown>): string | null {
  const message = firstUserMessage(body);
  if (!message) return null;
  return `message:${createHash('sha256').update(message).digest('hex').slice(0, 16)}`;
}

export const SESSION_AFFINITY_SOURCES = [
  'header:x-claude-code-session-id',
  'header:session-id',
  'header:session_id',
  'header:x-session-id',
  'header:x-client-session-id',
  'header:x-session-affinity',
  'header:x-amp-thread-id',
  'body:session_id',
  'body:sessionId',
  'body:metadata.user_id.session_id',
  'body:metadata.user_id.sessionId',
  'body:metadata.user_id.legacy-session-suffix',
  'body:conversation',
  'body:conversation_id',
  'body:prompt_cache_key',
  'body:metadata.user_id',
  'header:x-client-request-id',
  'fallback:first-user-message',
] as const;

export type SessionAffinitySource = typeof SESSION_AFFINITY_SOURCES[number];

export interface SessionAffinitySignal {
  source: SessionAffinitySource;
  key: string;
  bindingEligible: boolean;
}

interface ClaudeMetadataSessionSignal {
  source: Extract<SessionAffinitySource,
    | 'body:metadata.user_id.session_id'
    | 'body:metadata.user_id.sessionId'
    | 'body:metadata.user_id.legacy-session-suffix'>;
  key: string;
}

/** Return every usable identity signal in canonical precedence order. */
export function extractSessionAffinitySignals(
  headers: SessionAffinityHeaders | undefined,
  parsedBody: unknown,
): SessionAffinitySignal[] {
  const signals: SessionAffinitySignal[] = [];
  const add = (source: SessionAffinitySource, key: string | null, bindingEligible = true): void => {
    if (key) signals.push({ source, key, bindingEligible });
  };

  const body = objectValue(parsedBody);
  add('header:x-claude-code-session-id', namespaced('claude', headerValue(headers, 'x-claude-code-session-id')));

  // Native Claude body metadata is the next strongest signal. CPA and other
  // Anthropic-compatible routers may also forward coarse generic headers;
  // those must not collapse distinct Claude sessions.
  const claudeSession = body ? claudeMetadataSessionSignal(body) : null;
  if (claudeSession) add(claudeSession.source, claudeSession.key);

  const explicitHeaders: Array<[string, SessionAffinitySource, string]> = [
    ['session-id', 'header:session-id', 'session'],
    ['session_id', 'header:session_id', 'session'],
    ['x-session-id', 'header:x-session-id', 'session'],
    ['x-client-session-id', 'header:x-client-session-id', 'session'],
    ['x-session-affinity', 'header:x-session-affinity', 'affinity'],
    ['x-amp-thread-id', 'header:x-amp-thread-id', 'amp'],
  ];
  for (const [header, source, namespace] of explicitHeaders) {
    add(source, namespaced(namespace, headerValue(headers, header)));
  }

  if (!body) {
    const requestId = headerValue(headers, 'x-client-request-id');
    add('header:x-client-request-id', requestId ? `client-request:${requestId}` : null, false);
    return signals;
  }

  add('body:session_id', namespaced('session', body.session_id));
  add('body:sessionId', namespaced('session', body.sessionId));
  add('body:conversation', conversationId(body));
  add('body:conversation_id', namespaced('conversation', body.conversation_id));
  add('body:prompt_cache_key', namespaced('prompt-cache', body.prompt_cache_key), false);

  const metadata = objectValue(body.metadata);
  if (!claudeSession) add('body:metadata.user_id', namespaced('user', metadata?.user_id), false);

  const requestId = headerValue(headers, 'x-client-request-id');
  add('header:x-client-request-id', requestId ? `client-request:${requestId}` : null, false);
  add('fallback:first-user-message', messageHash(body), false);
  return signals;
}

/** Select the first signal that is unique and stable enough to bind. */
export function selectSessionAffinitySignal(
  signals: readonly SessionAffinitySignal[],
): SessionAffinitySignal | null {
  return signals.find((signal) => signal.bindingEligible) ?? null;
}

/**
 * Resolve a stable conversation identity for account affinity.
 *
 * Native Claude header/body identity takes precedence, followed by explicit
 * generic client/session signals and stable conversation fields.
 * Request IDs, prompt-cache keys, legacy user IDs, and message hashes remain
 * available as diagnostics but are deliberately excluded from bindings.
 */
export function extractSessionAffinityKey(
  headers: SessionAffinityHeaders | undefined,
  parsedBody: unknown,
): string | null {
  return selectSessionAffinitySignal(extractSessionAffinitySignals(headers, parsedBody))?.key ?? null;
}
