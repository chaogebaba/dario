import { createHash } from 'node:crypto';

export type SessionAffinityHeaders =
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null };

const MAX_EXPLICIT_ID_LENGTH = 512;
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

function claudeMetadataSessionId(body: Record<string, unknown>): string | null {
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
      if (marker >= 0) return namespaced('claude', rawUserId.slice(marker + 9));
    }
  }
  return identity
    ? namespaced('claude', identity.session_id ?? identity.sessionId)
    : null;
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
    return content.length > 0 ? content : null;
  }
  if (!Array.isArray(record.content)) return null;

  const text = record.content
    .map((part) => {
      const block = objectValue(part);
      return block?.type === 'text' && typeof block.text === 'string' ? block.text : '';
    })
    .filter((part) => part.length > 0)
    .join('\n')
    .trim();
  return text.length > 0 ? text : null;
}

function messageHash(body: Record<string, unknown>): string | null {
  const message = firstUserMessage(body);
  if (!message) return null;
  return `message:${createHash('sha256').update(message).digest('hex').slice(0, 16)}`;
}

/**
 * Resolve a stable conversation identity for account affinity.
 *
 * Explicit client/session signals take precedence over body-derived values.
 * The final message fallback hashes every text block in the first user turn:
 * Claude clients often prepend a shared system-reminder block, so hashing only
 * the first block collapses unrelated conversations onto one pool account.
 */
export function extractSessionAffinityKey(
  headers: SessionAffinityHeaders | undefined,
  parsedBody: unknown,
): string | null {
  const explicitHeaders: Array<[string, string]> = [
    ['x-claude-code-session-id', 'claude'],
    ['session-id', 'codex'],
    ['session_id', 'codex'],
    ['x-session-id', 'header'],
    ['x-client-session-id', 'client-session'],
    ['x-session-affinity', 'affinity'],
    ['x-amp-thread-id', 'amp'],
  ];
  for (const [header, namespace] of explicitHeaders) {
    const value = headerValue(headers, header);
    if (value) return `${namespace}:${value}`;
  }

  const body = objectValue(parsedBody);
  if (!body) return null;

  const bodySession = namespaced('session', body.session_id ?? body.sessionId);
  if (bodySession) return bodySession;

  const claudeSession = claudeMetadataSessionId(body);
  if (claudeSession) return claudeSession;

  const conversation = conversationId(body);
  if (conversation) return conversation;

  // Conversation identity is stable across turns even when a client starts
  // sending a prompt-cache key later. Prefer it so adding cache metadata does
  // not silently rebind an active session to the next round-robin account.
  const promptCacheKey = namespaced('prompt-cache', body.prompt_cache_key);
  if (promptCacheKey) return promptCacheKey;

  const metadata = objectValue(body.metadata);
  const legacyUser = namespaced('user', metadata?.user_id);
  if (legacyUser) return legacyUser;

  const legacyConversation = namespaced('conversation', body.conversation_id);
  if (legacyConversation) return legacyConversation;

  const requestId = headerValue(headers, 'x-client-request-id');
  if (requestId) return `client-request:${requestId}`;
  return messageHash(body);
}
