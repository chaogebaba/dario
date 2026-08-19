import { formatResetInstant, formatResetRelative, quotaBand } from '../quota.js';
import { bold, brand, dim, fg, pad, progressBar, truncate } from './render.js';
import type { AccountRow, AccountsState } from './accounts-state.js';

export function renderAccounts(state: AccountsState, viewport: { cols: number; rows: number }): string {
  const lines: string[] = [];
  const width = viewport.cols;
  const push = (line: string) => lines.push(truncate(line, width));

  push(' ' + brand('Accounts'));
  if (state.loading && state.accounts.length === 0) {
    push('');
    push('  ' + dim('Loading accounts…'));
    return lines.join('\n');
  }

  if (state.accounts.length === 0) {
    push('');
    renderEmptyState(state, lines, push);
    push('');
    push(' ' + dim(`${fg('cyan', 'n')} add  ${fg('cyan', 'r')} refresh`));
    return lines.join('\n');
  }

  if (state.source === 'disk') {
    push('  ' + fg('yellow', terminalText('proxy unreachable — showing on-disk accounts (may be stale)')));
  }

  renderInteraction(state, lines, push);

  const hasQuota = state.accounts.some((account) => (account.quota?.windows.length ?? 0) > 0);
  const contentBudget = Math.max(2, viewport.rows - lines.length - 2);
  const windowed = accountWindow(state, contentBudget, hasQuota);
  if (windowed.hidden > 0 && contentBudget >= 3) {
    push('  ' + dim(`Showing accounts ${windowed.start + 1}-${windowed.end + 1} of ${state.accounts.length}`));
  }
  if (hasQuota) renderQuotaCards(windowed.state, push, width);
  else renderUtilTable(
    windowed.state,
    push,
    width,
    state.accounts.some((account) => account.util5h !== undefined),
    state.accounts.some(isMeasured),
  );

  push('');
  const hints = !state.mode || state.mode === 'normal'
    ? ` ${fg('cyan', 'n')} add  ${fg('cyan', 'd')} delete  ${fg('cyan', 'e')} rename  ${fg('cyan', 't')} toggle  ${fg('cyan', 'r')} refresh quota`
    : '';
  push(dim(hints));
  return lines.join('\n');
}

function renderEmptyState(
  state: AccountsState,
  lines: string[],
  push: (line: string) => void,
): void {
  if (state.mode === 'input-alias') {
    renderAliasInput(state, push, 'New account alias:', 'Enter to start OAuth (empty = auto-name from email), Esc to cancel');
  } else if (state.mode === 'adding') {
    renderAdding(state, lines, push);
  } else if (state.mode === 'finishing') {
    push('  ' + fg('cyan', terminalText(state.message ?? 'Finalizing account…')));
  } else if (state.source === 'single-account') {
    push('  ' + dim('Single-account mode (`dario login`) — no pool.'));
    push('  ' + 'Start a pool: press ' + fg('cyan', 'n') + ' or run ' + fg('cyan', 'dario accounts add <alias>'));
  } else {
    push('  ' + dim('No accounts in the pool.'));
    push('  ' + 'Add one: press ' + fg('cyan', 'n') + ' or run ' + fg('cyan', 'dario accounts add <alias>'));
  }

  if (!['adding', 'finishing', 'input-alias'].includes(state.mode) && state.message) {
    push('');
    push('  ' + fg(messageColor(state), terminalText(state.message)));
  }
}

function renderInteraction(state: AccountsState, lines: string[], push: (line: string) => void): void {
  if (state.mode === 'input-alias') {
    push('');
    renderAliasInput(state, push, 'New account alias:', 'Enter to start OAuth (empty = auto-name from email), Esc to cancel');
  } else if (state.mode === 'adding') {
    push('');
    renderAdding(state, lines, push);
  } else if (state.mode === 'finishing') {
    push('');
    push('  ' + fg('cyan', terminalText(state.message ?? 'Finalizing account…')));
  } else if (state.mode === 'edit-alias') {
    push('');
    renderAliasInput(state, push, 'Rename alias:', 'Enter to confirm, Esc to cancel');
  } else if (state.message) {
    push('');
    push('  ' + fg(messageColor(state), terminalText(state.message)));
  }
}

function renderAliasInput(
  state: AccountsState,
  push: (line: string) => void,
  label: string,
  hint: string,
): void {
  push('  ' + bold(terminalText(label) + ' ') + terminalText(state.editBuffer ?? '') + fg('cyan', '_'));
  push('  ' + dim(terminalText(hint)));
  if (state.message) push('  ' + fg(messageColor(state), terminalText(state.message)));
}

function renderAdding(state: AccountsState, lines: string[], push: (line: string) => void): void {
  if (!state.authorizeUrl) {
    push('  ' + fg('cyan', terminalText(state.message ?? 'Opening browser for OAuth…')));
    return;
  }
  push('  ' + fg('cyan', 'Sign in to the new account in the browser. (Esc to cancel)'));
  push('');
  push('  ' + dim('URL (copy to another browser if needed):'));
  lines.push('  ' + fg('green', terminalText(state.authorizeUrl)));
}

function messageColor(state: AccountsState): 'red' | 'green' | 'yellow' | 'cyan' {
  if (state.messageKind === 'error') return 'red';
  if (state.messageKind === 'success') return 'green';
  if (state.messageKind === 'warning') return 'yellow';
  return 'cyan';
}

function renderQuotaCards(state: AccountsState, push: (line: string) => void, width: number): void {
  const now = Date.now();
  const labelWidth = Math.max(14, ...state.accounts.flatMap((account) =>
    (account.quota?.windows ?? []).map((window) => terminalText(window.label).length)));
  const barWidth = Math.max(8, Math.min(width - 8, 56));

  for (let index = 0; index < state.accounts.length; index++) {
    const account = state.accounts[index]!;
    push('');
    push('  ' + accountHeader(account, index === state.selectedIdx, account.quota?.plan));
    if (account.refreshError) {
      push('    ' + fg('yellow', 'token refresh failed: ') + dim(terminalText(account.refreshError)));
    }
    const windows = account.quota?.windows ?? [];
    if (account.quota?.error) {
      push('    ' + fg('yellow', 'quota unavailable: ') + dim(terminalText(account.quota.error)));
      if (isMeasured(account)) renderUtilWindows(account, push, barWidth, labelWidth);
      continue;
    }
    if (windows.length === 0) {
      if (isMeasured(account)) {
        renderUtilWindows(account, push, barWidth, labelWidth);
      } else {
        push('    ' + dim('no quota or usage measurement available'));
      }
      continue;
    }
    for (const window of windows) {
      const percent = window.remainingPercent === null ? '--' : `${Math.round(window.remainingPercent)}%`;
      const relative = formatResetRelative(window.resetsAt, now);
      const reset = window.resetsAt === null
        ? ''
        : `${formatResetInstant(window.resetsAt)}${relative ? ` · ${relative}` : ''}`;
      push('    ' + pad(terminalText(window.label), labelWidth) + ' ' + pad(bold(percent), 6, 'right')
        + (reset ? '   ' + dim(reset) : ''));
      push('    ' + meter(window.remainingPercent, barWidth));
    }
  }
}

function renderUtilTable(
  state: AccountsState,
  push: (line: string) => void,
  width: number,
  hasUtil: boolean,
  anyMeasured: boolean,
): void {
  const barWidth = Math.max(8, Math.min(width - 8, 56));
  const labelWidth = 14;
  for (let index = 0; index < state.accounts.length; index++) {
    const account = state.accounts[index]!;
    push('');
    push('  ' + accountHeader(account, index === state.selectedIdx, account.quota?.plan));
    if (account.refreshError) {
      push('    ' + fg('yellow', 'token refresh failed: ') + dim(terminalText(account.refreshError)));
    }
    if (!hasUtil || !isMeasured(account)) {
      push(!hasUtil
        ? '    ' + dim('~/.dario/accounts/' + terminalText(account.alias) + '.json')
        : '    ' + dim('no usage observed yet — ') + '—' + dim(' util5h  ') + '—' + dim(' util7d'));
      continue;
    }
    renderUtilWindows(account, push, barWidth, labelWidth);
  }
  if (hasUtil && !anyMeasured) {
    push('');
    push('  ' + dim('util is read from proxied responses — none seen yet this run.'));
    push('  ' + dim('For a reading now: ') + fg('cyan', 'dario doctor --usage'));
  }
}

function accountWindow(
  state: AccountsState,
  rowBudget: number,
  hasQuota: boolean,
): { state: AccountsState; start: number; end: number; hidden: number } {
  const requestedSelection = Number.isInteger(state.selectedIdx) ? state.selectedIdx : 0;
  const selected = Math.max(0, Math.min(requestedSelection, state.accounts.length - 1));
  const hasUtil = state.accounts.some((account) => account.util5h !== undefined);
  const anyMeasured = state.accounts.some(isMeasured);
  const costs = state.accounts.map((account) => accountRowCost(account, hasQuota, hasUtil));
  const globalRows = !hasQuota && hasUtil && !anyMeasured ? 3 : 0;
  const noteReserve = state.accounts.length > 1 ? 1 : 0;
  const available = Math.max(2, rowBudget - globalRows - noteReserve);
  let start = selected;
  let end = selected;
  let used = costs[selected] ?? 2;
  let preferBefore = true;

  while (start > 0 || end < state.accounts.length - 1) {
    const candidates = preferBefore ? [start - 1, end + 1] : [end + 1, start - 1];
    let added = false;
    for (const candidate of candidates) {
      if (candidate < 0 || candidate >= state.accounts.length) continue;
      const candidateCost = costs[candidate] ?? 2;
      if (used + candidateCost > available) continue;
      if (candidate < start) start = candidate;
      else end = candidate;
      used += candidateCost;
      preferBefore = !preferBefore;
      added = true;
      break;
    }
    if (!added) break;
  }

  const hidden = state.accounts.length - (end - start + 1);
  return {
    state: {
      ...state,
      accounts: state.accounts.slice(start, end + 1),
      selectedIdx: selected - start,
    },
    start,
    end,
    hidden,
  };
}

function accountRowCost(account: AccountRow, hasQuota: boolean, hasUtil: boolean): number {
  const refreshErrorRows = account.refreshError ? 1 : 0;
  if (!hasQuota) return 2 + refreshErrorRows + (!hasUtil || !isMeasured(account) ? 1 : 4);
  if (account.quota?.error) return 3 + refreshErrorRows + (isMeasured(account) ? 4 : 0);
  const windows = account.quota?.windows ?? [];
  if (windows.length > 0) return 2 + refreshErrorRows + windows.length * 2;
  return 2 + refreshErrorRows + (isMeasured(account) ? 4 : 1);
}

function accountHeader(account: AccountRow, selected: boolean, plan?: string | null): string {
  const marker = selected ? fg('cyan', '>') : ' ';
  const safeEmail = terminalText(account.quota?.email ?? '');
  const email = safeEmail ? `  ${dim('email ')}${safeEmail}` : '';
  const status = account.status && account.status !== 'unknown'
    ? '   ' + (account.status.includes('cooldown') || account.status === 'rejected' || account.status === 'refresh-failed'
      ? fg('yellow', terminalText(account.status))
      : dim(terminalText(account.status)))
    : '';
  const planText = plan ? '   ' + dim('Plan ') + bold(terminalText(plan)) : '';
  const alias = terminalText(account.alias);
  const enabled = account.enabled !== false;
  return `${marker} ${selected ? bold(alias) : alias}${email}  ${dim('token ')}${enabled ? formatExpiry(account.expiresAt) : dim('off')}${planText}${status}`;
}

function terminalText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

function renderUtilWindows(
  account: AccountRow,
  push: (line: string) => void,
  barWidth: number,
  labelWidth: number,
): void {
  const used5h = Math.round((account.util5h ?? 0) * 100);
  const used7d = Math.round((account.util7d ?? 0) * 100);
  push('    ' + pad('util5h', labelWidth) + ' ' + pad(bold(`${used5h}%`), 6, 'right') + dim(' used'));
  push('    ' + meter(Math.max(0, Math.min(100, 100 - used5h)), barWidth));
  push('    ' + pad('util7d', labelWidth) + ' ' + pad(bold(`${used7d}%`), 6, 'right') + dim(' used'));
  push('    ' + meter(Math.max(0, Math.min(100, 100 - used7d)), barWidth));
}

function meter(remainingPercent: number | null, width: number): string {
  const band = quotaBand(remainingPercent);
  const bar = progressBar((remainingPercent ?? 0) / 100, width);
  if (band === 'unknown') return dim(bar);
  const color = band === 'high' ? 'green' : band === 'medium' ? 'yellow' : 'red';
  const cells = Math.round(Math.max(0, Math.min(1, (remainingPercent ?? 0) / 100)) * width);
  return fg(color, bar.slice(0, cells)) + dim(bar.slice(cells));
}

function isMeasured(account: AccountRow): boolean {
  if (account.measuredAt !== undefined) return account.measuredAt > 0;
  return account.util5h !== undefined;
}

function formatExpiry(expiresAt: number): string {
  if (expiresAt === 0) return dim('—');
  const remainingMs = expiresAt - Date.now();
  if (remainingMs < 0) return fg('yellow', 'expired');
  const hours = Math.floor(remainingMs / 3_600_000);
  const minutes = Math.floor((remainingMs % 3_600_000) / 60_000);
  if (hours > 24) return fg('green', `${Math.floor(hours / 24)}d ${hours % 24}h`);
  if (hours > 0) return fg('green', `${hours}h ${minutes}m`);
  return fg('green', `${minutes}m`);
}
