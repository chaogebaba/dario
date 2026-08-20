import type { QuotaWindow } from '../quota.js';
import { isValidAccountAlias } from '../account-alias.js';
import type { Key } from './input.js';

export interface AccountQuota {
  windows: QuotaWindow[];
  plan: string | null;
  email: string | null;
  error?: string;
}

export interface AccountRow {
  alias: string;
  expiresAt: number;
  util5h?: number;
  util7d?: number;
  status?: string;
  enabled?: boolean;
  refreshError?: string;
  measuredAt?: number;
  quota?: AccountQuota;
}

export type AccountsMode =
  | 'normal'
  | 'confirm-delete'
  | 'edit-alias'
  | 'input-alias'
  | 'adding'
  | 'finishing';

export type AccountsAction =
  | { type: 'refresh'; forceQuota: boolean; reconcile: boolean }
  | { type: 'add'; alias: string }
  | { type: 'cancel-add' }
  | { type: 'delete'; alias: string; selectedIdx: number }
  | { type: 'rename'; oldAlias: string; newAlias: string }
  | { type: 'toggle'; alias: string; enabled: boolean; selectedIdx: number };

export interface AccountsState {
  loading: boolean;
  accounts: AccountRow[];
  error: string | null;
  source?: 'pool' | 'single-account' | 'disk';
  selectedIdx: number;
  mode: AccountsMode;
  editBuffer: string | null;
  message: string | null;
  messageKind: 'success' | 'error' | 'info' | 'warning' | null;
  authorizeUrl: string | null;
  pendingAction: AccountsAction | null;
}

export function initialAccountsState(): AccountsState {
  return {
    loading: true,
    accounts: [],
    error: null,
    selectedIdx: 0,
    mode: 'normal',
    editBuffer: null,
    message: null,
    messageKind: null,
    authorizeUrl: null,
    pendingAction: null,
  };
}

export function accountsCaptureGlobalKeys(state: AccountsState): boolean {
  return state.mode !== undefined && state.mode !== 'normal';
}

export function reduceAccountsKey(state: AccountsState, key: Key): AccountsState | undefined {
  if (state.mode === 'input-alias') return reduceAliasInput(state, key, true);
  if (state.mode === 'edit-alias') return reduceAliasInput(state, key, false);

  if (state.mode === 'confirm-delete') {
    if (key.name === 'printable' && (key.ch === 'y' || key.ch === 'Y')) {
      const alias = state.accounts[state.selectedIdx]?.alias;
      if (!alias) return { ...state, mode: 'normal', message: null, messageKind: null };
      return {
        ...state,
        mode: 'normal',
        message: 'Deleting…',
        messageKind: 'info',
        pendingAction: { type: 'delete', alias, selectedIdx: state.selectedIdx },
      };
    }
    return { ...state, mode: 'normal', message: null, messageKind: null };
  }

  if (state.mode === 'adding') {
    if (key.name === 'escape') {
      return {
        ...state,
        mode: 'normal',
        message: 'Add cancelled.',
        messageKind: 'info',
        authorizeUrl: null,
        editBuffer: null,
        pendingAction: { type: 'cancel-add' },
      };
    }
    return undefined;
  }
  if (state.mode === 'finishing') return undefined;

  if (key.name === 'up' && state.accounts.length > 0) {
    return { ...state, selectedIdx: Math.max(0, state.selectedIdx - 1) };
  }
  if (key.name === 'down' && state.accounts.length > 0) {
    return { ...state, selectedIdx: Math.min(state.accounts.length - 1, state.selectedIdx + 1) };
  }
  if (key.name === 'printable' && key.ch === 'r' && !key.ctrl) {
    return {
      ...state,
      loading: true,
      message: null,
      messageKind: null,
      pendingAction: { type: 'refresh', forceQuota: true, reconcile: true },
    };
  }
  if (key.name === 'printable' && key.ch === 'n' && !key.ctrl) {
    return {
      ...state,
      mode: 'input-alias',
      editBuffer: '',
      message: null,
      messageKind: null,
      authorizeUrl: null,
    };
  }
  if (key.name === 'printable' && (key.ch === 'd' || key.ch === 'x') && !key.ctrl) {
    const alias = state.accounts[state.selectedIdx]?.alias;
    if (!alias) return undefined;
    return {
      ...state,
      mode: 'confirm-delete',
      message: `Delete "${alias}"? Press y to confirm, any other key to cancel.`,
      messageKind: 'info',
    };
  }
  if (key.name === 'printable' && key.ch === 'e' && !key.ctrl) {
    const alias = state.accounts[state.selectedIdx]?.alias;
    if (!alias) return undefined;
    return { ...state, mode: 'edit-alias', editBuffer: alias, message: null, messageKind: null };
  }
  // Exact `t`, like every other key on this tab. It was the one matched
  // case-insensitively, so shift-T — a plausible slip on a keyboard where the
  // shift key is already down — put a deliberately benched account back into
  // routing, and back into billing, with no confirm step in the way.
  if (key.name === 'printable' && key.ch === 't' && !key.ctrl) {
    const account = state.accounts[state.selectedIdx];
    if (!account) return undefined;
    return {
      ...state,
      message: 'Updating account…',
      messageKind: 'info',
      // The state to move to, decided here off the row the operator is looking
      // at, rather than left to the server to infer from what it finds.
      // `enabled` is optional on the row and absent means on, which is why this
      // is `=== false` and not `!`.
      pendingAction: { type: 'toggle', alias: account.alias, enabled: account.enabled === false, selectedIdx: state.selectedIdx },
    };
  }
  return undefined;
}

function reduceAliasInput(state: AccountsState, key: Key, adding: boolean): AccountsState | undefined {
  if (key.name === 'escape') {
    return { ...state, mode: 'normal', editBuffer: null, message: null, messageKind: null };
  }
  if (key.name === 'enter') {
    const alias = (state.editBuffer ?? '').trim();
    if (adding) {
      if (alias && !isValidAccountAlias(alias)) {
        return { ...state, message: 'Invalid alias — start with a letter or number; maximum 64 characters.', messageKind: 'error' };
      }
      if (alias && state.accounts.some((a) => a.alias.toLowerCase() === alias.toLowerCase())) {
        return { ...state, message: `"${alias}" already exists — pick a different name.`, messageKind: 'error' };
      }
      return {
        ...state,
        mode: 'adding',
        message: 'Opening browser for OAuth…',
        messageKind: 'info',
        authorizeUrl: null,
        pendingAction: { type: 'add', alias },
      };
    }

    const oldAlias = state.accounts[state.selectedIdx]?.alias;
    if (!oldAlias || !alias) return undefined;
    return {
      ...state,
      mode: 'normal',
      message: 'Renaming…',
      messageKind: 'info',
      pendingAction: { type: 'rename', oldAlias, newAlias: alias },
    };
  }
  if (key.name === 'backspace') {
    return { ...state, editBuffer: (state.editBuffer ?? '').slice(0, -1) };
  }
  if (key.name === 'printable' && key.ch && !key.ctrl) {
    return { ...state, editBuffer: (state.editBuffer ?? '') + key.ch };
  }
  return undefined;
}
