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
    push('  ' + fg('yellow', 'proxy unreachable — showing on-disk accounts (may be stale)'));
  }

  const hasQuota = state.accounts.some((account) => (account.quota?.windows.length ?? 0) > 0);
  if (hasQuota) renderQuotaCards(state, push, width);
  else renderUtilTable(state, push, width);

  renderInteraction(state, lines, push);
  push('');
  const hints = !state.mode || state.mode === 'normal'
    ? ` ${fg('cyan', 'n')} add  ${fg('cyan', 'd')} delete  ${fg('cyan', 'e')} rename  ${fg('cyan', 'r')} refresh quota`
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
    push('  ' + fg('cyan', state.message ?? 'Finalizing account…'));
  } else if (state.source === 'single-account') {
    push('  ' + dim('Single-account mode (`dario login`) — no pool.'));
    push('  ' + 'Start a pool: press ' + fg('cyan', 'n') + ' or run ' + fg('cyan', 'dario accounts add <alias>'));
  } else {
    push('  ' + dim('No accounts in the pool.'));
    push('  ' + 'Add one: press ' + fg('cyan', 'n') + ' or run ' + fg('cyan', 'dario accounts add <alias>'));
  }

  if (!['adding', 'finishing', 'input-alias'].includes(state.mode) && state.message) {
    push('');
    push('  ' + fg(messageColor(state), state.message));
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
    push('  ' + fg('cyan', state.message ?? 'Finalizing account…'));
  } else if (state.mode === 'edit-alias') {
    push('');
    renderAliasInput(state, push, 'Rename alias:', 'Enter to confirm, Esc to cancel');
  } else if (state.message) {
    push('');
    push('  ' + fg(messageColor(state), state.message));
  }
}

function renderAliasInput(
  state: AccountsState,
  push: (line: string) => void,
  label: string,
  hint: string,
): void {
  push('  ' + bold(label + ' ') + (state.editBuffer ?? '') + fg('cyan', '_'));
  push('  ' + dim(hint));
  if (state.message) push('  ' + fg(messageColor(state), state.message));
}

function renderAdding(state: AccountsState, lines: string[], push: (line: string) => void): void {
  if (!state.authorizeUrl) {
    push('  ' + fg('cyan', state.message ?? 'Opening browser for OAuth…'));
    return;
  }
  push('  ' + fg('cyan', 'Sign in to the new account in the browser. (Esc to cancel)'));
  push('');
  push('  ' + dim('URL (copy to another browser if needed):'));
  lines.push('  ' + fg('green', state.authorizeUrl));
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
    (account.quota?.windows ?? []).map((window) => window.label.length)));
  const barWidth = Math.max(8, Math.min(width - 8, 56));

  for (let index = 0; index < state.accounts.length; index++) {
    const account = state.accounts[index]!;
    push('');
    push('  ' + accountHeader(account, index === state.selectedIdx, account.quota?.plan));
    const windows = account.quota?.windows ?? [];
    if (account.quota?.error) {
      push('    ' + fg('yellow', 'quota unavailable: ') + dim(account.quota.error));
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
      push('    ' + pad(window.label, labelWidth) + ' ' + pad(bold(percent), 6, 'right')
        + (reset ? '   ' + dim(reset) : ''));
      push('    ' + meter(window.remainingPercent, barWidth));
    }
  }
}

function renderUtilTable(state: AccountsState, push: (line: string) => void, width: number): void {
  const hasUtil = state.accounts.some((account) => account.util5h !== undefined);
  const barWidth = Math.max(8, Math.min(width - 8, 56));
  const labelWidth = 14;
  for (let index = 0; index < state.accounts.length; index++) {
    const account = state.accounts[index]!;
    push('');
    push('  ' + accountHeader(account, index === state.selectedIdx));
    if (!hasUtil || !isMeasured(account)) {
      push(!hasUtil
        ? '    ' + dim('~/.dario/accounts/' + account.alias + '.json')
        : '    ' + dim('no usage observed yet — ') + '—' + dim(' util5h  ') + '—' + dim(' util7d'));
      continue;
    }
    renderUtilWindows(account, push, barWidth, labelWidth);
  }
  if (hasUtil && !state.accounts.some(isMeasured)) {
    push('');
    push('  ' + dim('util is read from proxied responses — none seen yet this run.'));
    push('  ' + dim('For a reading now: ') + fg('cyan', 'dario doctor --usage'));
  }
}

function accountHeader(account: AccountRow, selected: boolean, plan?: string | null): string {
  const marker = selected ? fg('cyan', '>') : ' ';
  const emailNorm = account.quota?.email?.replace(/@/g, '.').replace(/[^a-zA-Z0-9._-]/g, '') ?? '';
  const email = account.quota?.email && emailNorm !== account.alias ? '  ' + dim(account.quota.email) : '';
  const status = account.status && account.status !== 'unknown'
    ? '   ' + (account.status === 'auth-cooldown' ? fg('yellow', account.status) : dim(account.status))
    : '';
  const planText = plan ? '   ' + dim('Plan ') + bold(plan) : '';
  return `${marker} ${selected ? bold(account.alias) : account.alias}${email}  ${dim('token ')}${formatExpiry(account.expiresAt)}${planText || status}`;
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
