/**
 * Hits tab — live request stream with per-record detail drill-down.
 *
 * Subscribes to /analytics/stream on mount. Each incoming RequestRecord
 * is prepended to the buffer (newest at the top of the visible list).
 * Up/Down navigate the selection; the lower pane shows the selected
 * record's full field set.
 *
 * Layout:
 *
 *   ┌─ Hits ────────────────────────[ ↑↓ select · r refresh ]
 *   │  HH:MM:SS  METHOD  MODEL          IN     OUT   LAT    ST
 *   │  18:42:01  POST    fable-5        842    216   1.2s  200  ←
 *   │  18:42:03  POST    sonnet-5       1.2k   480   0.8s  200
 *   │  …
 *   ├─────────────────────────────────────────────────────────────
 *   │  selected: 18:42:01  req_011…NvMn
 *   │    account:  sprayberryit (single)
 *   │    model:    claude-fable-5
 *   │    bucket:   subscription
 *   │    tokens:   in 842 / out 216 / cache-read 6.2k / thinking 84
 *   │    latency:  1.18s   stream: yes  status: 200
 *   │    5h util:  18%     7d util: 8%
 *   └─────────────────────────────────────────────────────────────
 */

import type { Tab, TabContext, TabDimensions } from '../tab.js';
import { fg, dim, brand, inverse, BOX, pad, truncate, visibleWidth } from '../render.js';
import { renderKvRow } from '../layout.js';
import { billingBucketFromClaim, isNonSubscriptionBilling, withoutRequestPreviews } from '../../analytics.js';
import type { RequestRecord } from '../../analytics.js';

const MAX_BUFFER = 5000;
const MAX_CONTENT_BUFFER = 512;

/** Live overage-halt state — populated from SSE event:overage_halt frames. */
interface HitsHaltState {
  since: number;
  cooldownUntil: number;
  request: { timestamp: number; model: string; account: string; claim: string };
}

export interface HitsState {
  buffer: RequestRecord[];   // newest LAST in the array; we render newest-first
  selectedIdx: number;       // 0 = newest; -1 = none / not yet selected
  subscribed: boolean;
  connectionError: string | null;
  /** Overage-guard halt banner (v4.1, dario#288). Null when running normally. */
  halt: HitsHaltState | null;
  detailOpen: boolean;
  detailScroll: number;
}

export const HitsTab: Tab<HitsState> = {
  id: 'hits',
  label: 'Hits',
  hotkey: 'h',

  initialState(): HitsState {
    return { buffer: [], selectedIdx: -1, subscribed: false, connectionError: null, halt: null, detailOpen: false, detailScroll: 0 };
  },

  onMount(_state, ctx) {
    // Subscribe to the live stream. Each record is prepended-conceptually
    // (we push to the array and render in reverse, which keeps the
    // buffer's mutation simple — Array.push is O(1) while unshift is O(n)).
    //
    // The same stream carries named events for overage-halt / -resume
    // (v4.1, dario#288). The SSE event type is the second argument; we
    // route on it.
    const close = ctx.client.subscribeAnalyticsStream<unknown>(
      (payload, eventType) => {
        if (eventType === 'overage_halt' || eventType === 'overage_warn') {
          const state = payload as HitsHaltState;
          ctx.setState((s: HitsState) => ({ ...s, halt: state }));
          return;
        }
        if (eventType === 'overage_resume') {
          ctx.setState((s: HitsState) => ({ ...s, halt: null }));
          return;
        }
        // Default ('message') = RequestRecord
        const record = payload as RequestRecord;
        ctx.setState((s: HitsState) => {
          const buffer = [...s.buffer, record].slice(-MAX_BUFFER);
          const contentExpiry = buffer.length - MAX_CONTENT_BUFFER - 1;
          if (contentExpiry >= 0) buffer[contentExpiry] = withoutRequestPreviews(buffer[contentExpiry]!);
          const next: HitsState = {
            ...s,
            buffer,
            subscribed: true,
            connectionError: null,
          };
          // selectedIdx is an offset into the reversed (newest-first) view.
          // A new record prepends to that view, pushing every existing item
          // down by 1. If the user was at idx 0 (newest), keep them there so
          // they auto-follow. If they scrolled down (idx > 0), shift to keep
          // the same record selected. -1 means "no selection yet"; auto-select
          // newest on first record.
          if (s.detailOpen && s.selectedIdx >= 0) {
            // An open inspector is a modal view of one record. New SSE
            // entries prepend to newestFirst, so shift the index to keep
            // the inspected record stable instead of silently replacing it.
            const max = next.buffer.length - 1;
            next.selectedIdx = Math.min(s.selectedIdx + 1, max);
          } else if (s.selectedIdx <= 0) {
            next.selectedIdx = 0;
          } else {
            // The new record went to the front of newestFirst, so the
            // previously-selected record moved from idx to idx+1.
            const max = next.buffer.length - 1;
            next.selectedIdx = Math.min(s.selectedIdx + 1, max);
          }
          return next;
        });
      },
      (err) => {
        ctx.setState({ subscribed: false, connectionError: err.message } as Partial<HitsState>);
      },
    );
    ctx.registerCleanup(close);
    return undefined;
  },

  onKey(state, key, dim) {
    if (state.buffer.length === 0) return undefined;
    if (state.detailOpen) {
      if (key.name === 'escape' || key.name === 'enter') return { ...state, detailOpen: false, detailScroll: 0 };
      const maxScroll = detailMaxScroll(state, dim);
      if (key.name === 'up') return setDetailScroll(state, Math.max(0, Math.min(maxScroll, state.detailScroll) - 1));
      if (key.name === 'down') return setDetailScroll(state, Math.min(maxScroll, Math.max(0, state.detailScroll) + 1));
      if (key.name === 'pageup') return setDetailScroll(state, Math.max(0, Math.min(maxScroll, state.detailScroll) - pageStep(dim)));
      if (key.name === 'pagedown') return setDetailScroll(state, Math.min(maxScroll, Math.max(0, state.detailScroll) + pageStep(dim)));
      if (key.name === 'home') return setDetailScroll(state, 0);
      if (key.name === 'end') return setDetailScroll(state, maxScroll);
      return undefined;
    }
    if (key.name === 'enter') return { ...state, detailOpen: true, detailScroll: 0 };
    // ↑ — move cursor UP on screen = toward NEWER (lower selectedIdx)
    if (key.name === 'up') {
      return { ...state, selectedIdx: Math.max(state.selectedIdx - 1, 0), detailScroll: 0 };
    }
    // ↓ — move cursor DOWN on screen = toward OLDER (higher selectedIdx)
    if (key.name === 'down') {
      const max = state.buffer.length - 1;
      return { ...state, selectedIdx: Math.min(state.selectedIdx + 1, max), detailScroll: 0 };
    }
    // PgUp / PgDn — step by 10
    if (key.name === 'pageup') {
      return { ...state, selectedIdx: Math.max(state.selectedIdx - 10, 0), detailScroll: 0 };
    }
    if (key.name === 'pagedown') {
      const max = state.buffer.length - 1;
      return { ...state, selectedIdx: Math.min(state.selectedIdx + 10, max), detailScroll: 0 };
    }
    // Home — jump to newest
    if (key.name === 'home') {
      return { ...state, selectedIdx: 0, detailScroll: 0 };
    }
    // End — jump to oldest
    if (key.name === 'end') {
      return { ...state, selectedIdx: state.buffer.length - 1, detailScroll: 0 };
    }
    return undefined;
  },

  render(state, dimv): string {
    const lines: string[] = [];
    const w = dimv.cols;
    const totalRows = dimv.rows;
    // Reserve the chrome this render will actually emit, rather than a
    // flat guess. The old `detailRows = 9; totalRows - detailRows - 2`
    // reserved 11 but the tab renders up to 15 non-list rows — the halt
    // banner was missing from the arithmetic entirely and the detail pane
    // is 9 rows, not 8 — so the body overran its budget by 4 (#868).
    const hasSelection = state.selectedIdx >= 0 && state.selectedIdx < state.buffer.length;
    const newestFirst = [...state.buffer].reverse();
    if (state.detailOpen && hasSelection) return renderInspector(newestFirst[state.selectedIdx], state, w, totalRows);
    const haltRows = state.halt ? 2 : 0;         // pinned banner
    const fixedRows =
      1 +            // title
      haltRows +
      1 +            // blank before the table
      1 +            // column header
      1;             // scroll hint (reserved; only drawn when the list overflows)
    const detailPaneRows = (hasSelection ? 9 : 2) + 1;   // pane + its separator
    // The list is the tab's reason to exist, so the detail pane yields to
    // it rather than the other way round: on a terminal too short to show
    // both, drop the pane and spend the rows on requests. Without this the
    // halt banner + an 8-row pane made a 15-row floor no budget could meet.
    const MIN_LIST = 3;
    const showDetail = totalRows - fixedRows - detailPaneRows >= MIN_LIST;
    const chromeRows = fixedRows + (showDetail ? detailPaneRows : 0);
    const listRows = Math.max(1, totalRows - chromeRows);

    if (state.buffer.length === 0) {
      lines.push(truncate(' ' + brand('Hits') + dim('  — live request stream'), w));
      lines.push('');
      if (state.connectionError) {
        // The error text is upstream-supplied and unbounded.
        lines.push(truncate('  ' + fg('red', `SSE error: ${state.connectionError}`), w));
        lines.push(truncate('  ' + dim('Is `dario proxy` running? The stream reconnects automatically on the next mount.'), w));
      } else if (!state.subscribed) {
        lines.push(truncate('  ' + dim('Connecting to /analytics/stream …'), w));
      } else {
        lines.push(truncate('  ' + dim('Waiting for requests. Send one through dario to see it land here.'), w));
      }
      return lines.join('\n');
    }

    // Render newest-first: the LAST element of the buffer renders at
    // the TOP of the list.
    const startIdx = clampVisibleStart(state.selectedIdx, listRows, newestFirst.length);
    const endIdx = Math.min(startIdx + listRows, newestFirst.length);

    // Column layout — fixed widths to keep alignment stable across
    // varied content. Fall back to truncation when columns overflow.
    const colTime = 9;
    const colModel = 16;
    const colIn = 7, colOut = 7, colCacheRead = 11, colCacheCreate = 14, colLat = 7, colStatus = 5;

    lines.push(truncate(' ' + brand('Hits') +
      dim(`  ${state.buffer.length} buffered · ${state.subscribed ? fg('green', 'live') : fg('yellow', 'disconnected')}`), w));

    // ── Overage-halt banner (v4.1, dario#288) ──────────────────
    // Pinned at the top so it's always visible while scrolling the buffer.
    //
    // Both lines are ordered most-actionable-first and kept short enough
    // to fit 80 columns, because a banner that wraps costs a second
    // physical row and pushes the panel head off the top of the screen —
    // and it wraps exactly when the user needs to read it. The account is
    // last on line 1 so a narrow terminal clips the least-critical field;
    // the resume instructions on line 2 fit outright.
    if (state.halt) {
      const since = formatTimestamp(state.halt.since);
      const cooldown = formatRemaining(state.halt.cooldownUntil - Date.now());
      const line1 = `  ${fg('red', '⚠ HALTED')}  ${state.halt.request.claim} · ${since} · ${shortenModel(state.halt.request.model)} · ${dim(state.halt.request.account)}`;
      const line2 = `  ${dim('→ 503 until')} ${fg('cyan', 'R')} ${dim('or')} ${fg('cyan', 'dario resume')} ${dim(`· auto-resume in ${cooldown}`)}`;
      lines.push(truncate(line1, w));
      lines.push(truncate(line2, w));
    }
    lines.push('');
    // Header row — truncated to the same budget as the data rows below
    // (`w - 2`) so the columns stay aligned when the terminal is narrow.
    lines.push(truncate('  ' + dim(
      pad('time', colTime) +
      pad('model', colModel) +
      pad('in', colIn) +
      pad('out', colOut) +
      pad('cache read', colCacheRead) +
      pad('cache create', colCacheCreate) +
      pad('lat', colLat) +
      pad('st', colStatus)
    ), w - 2));

    for (let i = startIdx; i < endIdx; i++) {
      const r = newestFirst[i];
      // Flag any non-subscription billing red — the same condition the
      // overage-guard halts on (overage, api, or a credit/SDK bucket), not
      // just literal `overage`. See isNonSubscriptionBilling (#288).
      const isNonSub = isNonSubscriptionBilling(r.claim);
      const marker = i === state.selectedIdx ? fg('cyan', '▎')
                   : isNonSub ? fg('red', '!')
                   : ' ';
      const row = marker + ' ' +
        pad(formatTime(r.timestamp), colTime) +
        pad(shortenModel(r.model), colModel) +
        pad(formatTokens(r.inputTokens), colIn) +
        pad(formatTokens(r.outputTokens), colOut) +
        pad(formatTokens(r.cacheReadTokens), colCacheRead) +
        pad(formatTokens(r.cacheCreateTokens), colCacheCreate) +
        pad(formatLatency(r.latencyMs), colLat) +
        pad(formatStatus(r.status), colStatus);
      // Non-subscription rows render in red even when unselected; selection
      // still wins via the inverse() wrapper so the user can drill into one.
      let styled: string;
      if (i === state.selectedIdx) styled = inverse(truncate(row, w - 2));
      else if (isNonSub) styled = fg('red', truncate(row, w - 2));
      else styled = truncate(row, w - 2);
      lines.push(styled);
    }

    // Scroll hint
    if (newestFirst.length > listRows) {
      lines.push(truncate(' ' + dim(
        `${state.selectedIdx + 1} / ${newestFirst.length}  ` +
        (startIdx > 0 ? '↑ more ' : '') +
        (endIdx < newestFirst.length ? '↓ more' : '')
      ), w));
    }

    // Separator + detail pane — omitted entirely on a terminal too short
    // to show both the list and the pane (see the budget above).
    if (!showDetail) return lines.join('\n');

    lines.push(' ' + dim(BOX.horizontal.repeat(Math.max(0, w - 2))));

    if (state.selectedIdx >= 0 && state.selectedIdx < newestFirst.length) {
      const r = newestFirst[state.selectedIdx];
      lines.push(truncate('  ' + brand('Selected') + dim(`  ${formatTime(r.timestamp)} · Enter inspect`), w));
      lines.push('  ' + renderKvRow('Account', r.account, w - 4));
      lines.push('  ' + renderKvRow('Model', r.model, w - 4));
      lines.push('  ' + renderKvRow('Billing bucket', billingBucketFromClaim(r.claim), w - 4));
      lines.push('  ' + renderKvRow('Tokens', tokenBreakdown(r), w - 4));
      lines.push('  ' + renderKvRow('Upstream attempts', String(r.upstreamAttempts ?? 1), w - 4));
      lines.push('  ' + renderKvRow('Latency', `${formatLatency(r.latencyMs)}  ${dim(r.isStream ? '(streaming)' : '(buffered)')}`, w - 4));
      lines.push('  ' + renderKvRow('Util at request',
        `5h ${(r.util5h * 100).toFixed(0)}%   7d ${(r.util7d * 100).toFixed(0)}%`, w - 4));
      lines.push('  ' + renderKvRow('Status', formatStatus(r.status), w - 4));
    } else {
      lines.push('');
      lines.push(truncate('  ' + dim('Use ↑↓ to select a request for details.'), w));
    }

    return lines.join('\n');
  },
};

/**
 * Decide what range of the (newest-first) buffer to show given the
 * current selection. Keeps the selection visible: if selected drifts
 * off the bottom we scroll down; off the top we scroll up.
 */
function clampVisibleStart(selectedIdx: number, listRows: number, total: number): number {
  if (selectedIdx < 0) return 0;
  // Try to keep selection roughly centered when scrolling
  const desired = selectedIdx - Math.floor(listRows / 3);
  return Math.max(0, Math.min(desired, Math.max(0, total - listRows)));
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function pad2(n: number): string { return n < 10 ? '0' + n : String(n); }

function shortenModel(model: string): string {
  return model.replace(/^claude-/, '');
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function formatLatency(ms: number): string {
  if (ms >= 1000) return (ms / 1000).toFixed(1) + 's';
  return ms + 'ms';
}

function formatStatus(code: number): string {
  if (code >= 200 && code < 300) return fg('green', String(code));
  if (code >= 400 && code < 500) return fg('yellow', String(code));
  if (code >= 500) return fg('red', String(code));
  return String(code);
}

function tokenBreakdown(r: RequestRecord): string {
  const parts = [`in ${r.inputTokens}`, `out ${r.outputTokens}`];
  if (r.cacheReadTokens > 0) parts.push(`cache-read ${formatTokens(r.cacheReadTokens)}`);
  if (r.cacheCreateTokens > 0) parts.push(`cache-create ${formatTokens(r.cacheCreateTokens)}`);
  if (r.thinkingTokens > 0) parts.push(`thinking ${r.thinkingTokens}`);
  return parts.join(' / ');
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return fg('yellow', 'now');
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function renderInspector(r: RequestRecord, state: HitsState, width: number, rows: number): string {
  const content = inspectorContent(r, state, width);
  const footerRows = 1;
  const viewportRows = Math.max(1, rows - footerRows);
  const maxScroll = Math.max(0, content.length - viewportRows);
  const scroll = Math.min(Math.max(0, state.detailScroll), maxScroll);
  const visible = content.slice(scroll, scroll + viewportRows).map((line) => truncate(line, width));
  const rangeEnd = Math.min(content.length, scroll + viewportRows);
  visible.push(truncate('  ' + dim(`Esc/Enter back · ↑↓ scroll · ${scroll + 1}-${rangeEnd}/${content.length}`), width));
  return visible.slice(0, rows).join('\n');
}

function inspectorContent(r: RequestRecord, state: HitsState, width: number): string[] {
  const inner = Math.max(16, width - 4);
  const content: string[] = [];
  const route = [r.method, r.path].filter(Boolean).join(' ') || 'request';
  content.push('  ' + brand('Request inspector') + dim(`  ${formatTime(r.timestamp)} · ${route}`));
  content.push('  ' + renderKvRow('Account / client', `${r.account}${r.client ? ` / ${r.client}` : ''}`, inner));
  content.push('  ' + renderKvRow('Model / status', `${r.model} / ${plainStatus(r.status)} / ${formatLatency(r.latencyMs)}`, inner));
  content.push('  ' + renderKvRow('Tokens', tokenBreakdown(r), inner));
  content.push('  ' + renderKvRow('Routing', `${r.upstreamAttempts ?? 1} upstream attempt${(r.upstreamAttempts ?? 1) === 1 ? '' : 's'} / ${billingBucketFromClaim(r.claim)}`, inner));
  const exactFingerprint = r.requestFingerprint;
  const repeats = exactFingerprint
    ? state.buffer.filter((candidate) => candidate.requestFingerprint === exactFingerprint).length
    : 0;
  const repeatNote = repeats > 1 ? ` / ${repeats} exact body matches in buffer` : '';
  content.push('  ' + renderKvRow('Request identity', `${r.requestFingerprint ?? '—'} / ${formatBytes(r.requestBytes ?? 0)}${repeatNote}`, inner));
  if (r.semanticFingerprint && r.semanticFingerprint !== r.requestFingerprint) {
    content.push('  ' + renderKvRow('Content identity', r.semanticFingerprint, inner));
  }
  content.push(' ' + dim(BOX.horizontal.repeat(Math.max(0, width - 2))));
  appendPreviewSection(content, 'Input', r.inputPreview, r.inputChars, r.inputTruncated, inner);
  content.push(' ' + dim(BOX.horizontal.repeat(Math.max(0, width - 2))));
  appendPreviewSection(content, 'Output', r.outputPreview, r.outputChars, r.outputTruncated, inner);
  return content;
}

function detailMaxScroll(state: HitsState, dim?: TabDimensions): number {
  const width = dim?.cols ?? 80;
  const rows = dim?.rows ?? 19;
  const newestFirst = [...state.buffer].reverse();
  const selected = newestFirst[state.selectedIdx];
  if (!selected) return 0;
  const contentRows = inspectorContent(selected, state, width).length;
  return Math.max(0, contentRows - Math.max(1, rows - 1));
}

function pageStep(dim?: TabDimensions): number {
  return Math.max(1, (dim?.rows ?? 19) - 2);
}

function setDetailScroll(state: HitsState, detailScroll: number): HitsState {
  return detailScroll === state.detailScroll ? state : { ...state, detailScroll };
}

function appendPreviewSection(
  lines: string[],
  label: string,
  preview: string | undefined,
  chars: number | undefined,
  truncatedPreview: boolean | undefined,
  width: number,
): void {
  const count = chars ?? preview?.length ?? 0;
  const suffix = `${formatTokens(count)} chars${truncatedPreview ? ' · stored preview truncated' : ''}`;
  lines.push('  ' + brand(label) + dim(`  ${suffix}`));
  if (!preview) {
    lines.push('  ' + dim(count > 0 ? '(preview aged out; token metadata retained)' : '(no textual content captured)'));
    return;
  }
  for (const line of wrapPlainText(preview, Math.max(8, width - 2))) lines.push(`  ${line}`);
}

function wrapPlainText(text: string, width: number): string[] {
  const rows: string[] = [];
  // Request text is untrusted terminal input. Preserve line structure and
  // tabs, but neutralize C0 controls (especially ESC/OSC/CSI introducers)
  // before it reaches the alternate screen.
  const terminalSafe = text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '?');
  for (const source of terminalSafe.split('\n')) {
    if (!source) { rows.push(''); continue; }
    let rest = source.replace(/\t/g, '    ');
    while (rest.length > 0) {
      let split = 0;
      let cells = 0;
      for (const ch of rest) {
        const w = visibleWidth(ch);
        if (cells + w > width) break;
        cells += w;
        split += ch.length;
      }
      if (split >= rest.length) {
        rows.push(rest);
        break;
      }
      const wordBreak = rest.lastIndexOf(' ', split);
      if (wordBreak >= Math.floor(split / 2)) split = wordBreak;
      if (split <= 0) split = Array.from(rest)[0]?.length ?? 1;
      rows.push(rest.slice(0, split));
      rest = rest.slice(split).trimStart();
    }
  }
  return rows;
}

function plainStatus(code: number): string { return String(code); }

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}
