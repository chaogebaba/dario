const DEFAULT_PREVIEW_CHARS = 8_192;
const MAX_PREVIEW_CHARS = 16_384;

export interface TextPreview {
  text: string;
  chars: number;
  truncated: boolean;
}

/** Redact common credential-shaped values before content reaches analytics or disk. */
export function redactPreviewText(value: string): string {
  return value
    .replace(/\b(?:sk-(?:ant|proj)-|ghp_|github_pat_|xox[baprs]-|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{20,}|npm_|pypi-)[A-Za-z0-9_./+=:-]{12,}/g, '[REDACTED]')
    .replace(/\b(password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [REDACTED]');
}

function previewLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_PREVIEW_CHARS;
  return Math.max(256, Math.min(MAX_PREVIEW_CHARS, Math.floor(limit)));
}

function cleanText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function cleanFragment(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
}

/** Keep both the beginning and the most recent tail of oversized text. */
export function boundPreview(value: string, limit = DEFAULT_PREVIEW_CHARS): TextPreview {
  const text = cleanText(value);
  const max = previewLimit(limit);
  if (text.length <= max) return { text, chars: text.length, truncated: false };

  const marker = '\n\n[... content omitted ...]\n\n';
  const available = Math.max(0, max - marker.length);
  const head = Math.floor(available / 3);
  const tail = available - head;
  return {
    text: text.slice(0, head) + marker + text.slice(-tail),
    chars: text.length,
    truncated: true,
  };
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : '[structured content omitted]';

  return content.flatMap((block): string[] => {
    if (typeof block === 'string') return [block];
    if (!block || typeof block !== 'object') return [];
    const b = block as Record<string, unknown>;
    switch (b.type) {
      case 'text':
        return typeof b.text === 'string' ? [b.text] : [];
      case 'thinking':
        return ['[thinking]'];
      case 'tool_use':
        // Tool arguments often contain file contents, environment variables,
        // or credentials. The tool name is enough to identify the caller;
        // never persist the arbitrary argument object in diagnostics.
        return [`[tool_use ${typeof b.name === 'string' ? b.name : 'unknown'}]`];
      case 'tool_result': {
        const id = typeof b.tool_use_id === 'string' ? ` ${b.tool_use_id}` : '';
        const failed = b.is_error === true ? ' error' : '';
        return [`[tool_result${id}${failed}] (content omitted)`];
      }
      case 'image':
      case 'document':
        return [`[${b.type}]`];
      default:
        return typeof b.text === 'string' ? [b.text] : [`[${typeof b.type === 'string' ? b.type : 'content'}]`];
    }
  }).join('\n');
}

/** Extract human-readable conversation content from Anthropic/OpenAI request JSON. */
export function extractRequestPreview(body: unknown, limit = DEFAULT_PREVIEW_CHARS): TextPreview {
  if (!body || typeof body !== 'object') return boundPreview('', limit);
  const parsed = body as Record<string, unknown>;
  const collector = new StreamingTextPreview(limit);
  const appendSection = (label: string, text: string): void => {
    if (text) collector.append(`${label}\n${text}\n\n`);
  };

  const system = contentText(parsed.system);
  appendSection('[system]', system);

  if (Array.isArray(parsed.messages)) {
    for (const raw of parsed.messages) {
      if (!raw || typeof raw !== 'object') continue;
      const message = raw as Record<string, unknown>;
      const role = typeof message.role === 'string' ? message.role : 'message';
      const text = contentText(message.content);
      appendSection(`[${role}]`, text);
    }
  } else if (typeof parsed.prompt === 'string') {
    appendSection('[prompt]', parsed.prompt);
  } else if (typeof parsed.input === 'string') {
    appendSection('[input]', parsed.input);
  }

  return collector.preview();
}

/** Extract visible assistant text and tool activity from a buffered response. */
export function extractResponsePreview(body: unknown, limit = DEFAULT_PREVIEW_CHARS): TextPreview {
  if (!body || typeof body !== 'object') return boundPreview('', limit);
  const parsed = body as Record<string, unknown>;
  const text = contentText(parsed.content);
  if (text) return boundPreview(text, limit);

  const choices = parsed.choices;
  if (Array.isArray(choices)) {
    const rendered = choices.flatMap((choice): string[] => {
      if (!choice || typeof choice !== 'object') return [];
      const message = (choice as Record<string, unknown>).message;
      if (!message || typeof message !== 'object') return [];
      return [contentText((message as Record<string, unknown>).content)];
    }).filter(Boolean).join('\n');
    return boundPreview(rendered, limit);
  }
  return boundPreview('', limit);
}

/** Bounded collector for streaming text deltas; memory does not grow with the response. */
export class StreamingTextPreview {
  private readonly max: number;
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private head = '';
  private tail = '';
  private total = 0;

  constructor(limit = DEFAULT_PREVIEW_CHARS) {
    this.max = previewLimit(limit);
    this.headLimit = Math.floor(this.max / 3);
    this.tailLimit = this.max - this.headLimit;
  }

  append(value: string): void {
    if (!value) return;
    this.total += value.length;
    // Do not normalize a multi-megabyte message just to retain an 8K
    // diagnostic window. Sample both ends; the final preview still reports
    // the complete character count and marks the omission.
    const scanLimit = 64 * 1024;
    const sample = value.length > scanLimit
      ? `${value.slice(0, scanLimit / 2)}\n[... fragment omitted ...]\n${value.slice(-scanLimit / 2)}`
      : value;
    const text = cleanFragment(sample);
    if (!text) return;
    if (this.head.length < this.headLimit) {
      const needed = this.headLimit - this.head.length;
      this.head += text.slice(0, needed);
    }
    this.tail = (this.tail + text).slice(-this.tailLimit);
  }

  preview(): TextPreview {
    if (this.total <= this.max) {
      const overlap = Math.max(0, this.head.length + this.tail.length - this.total);
      return boundPreview(this.head + this.tail.slice(overlap), this.max);
    }
    const marker = '\n\n[... content omitted ...]\n\n';
    const available = Math.max(0, this.max - marker.length);
    const head = this.head.slice(0, Math.floor(available / 3));
    const tail = this.tail.slice(-(available - head.length));
    return { text: head + marker + tail, chars: this.total, truncated: true };
  }
}
