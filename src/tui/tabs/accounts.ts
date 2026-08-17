/**
 * Accounts tab composition.
 *
 * Keyboard transitions, rendering, quota caching, and asynchronous account
 * operations live in focused modules. The controller is factory-scoped so a
 * TUI instance owns its refresh and OAuth cancellation state.
 */

import type { Tab } from '../tab.js';
import { AccountsController, refreshAccounts } from '../accounts-controller.js';
import { mergeQuotaEntries } from '../accounts-quota.js';
import { renderAccounts } from '../accounts-render.js';
import {
  accountsCaptureGlobalKeys,
  initialAccountsState,
  reduceAccountsKey,
  type AccountQuota,
  type AccountsState,
} from '../accounts-state.js';

export type { AccountQuota, AccountsState } from '../accounts-state.js';
export { mergeQuotaEntries, refreshAccounts };

export function createAccountsTab(): Tab<AccountsState> {
  const controller = new AccountsController();
  return {
    id: 'accounts',
    label: 'Accounts',
    hotkey: 'a',
    capturesGlobalKeys: accountsCaptureGlobalKeys,
    initialState: initialAccountsState,
    onMount: (_state, ctx) => {
      ctx.registerCleanup(() => controller.cancelAdd());
      return controller.mount(ctx);
    },
    onKey: (state, key) => {
      if (state.mode === 'adding' && key.name === 'escape') controller.cancelAdd();
      return reduceAccountsKey(state, key);
    },
    onTick: (state, ctx) => controller.tick(state, ctx),
    render: renderAccounts,
  };
}

export const AccountsTab = createAccountsTab();
