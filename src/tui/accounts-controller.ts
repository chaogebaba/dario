import { isValidAccountAlias } from '../account-alias.js';
import { CLAUDE_PROFILE_URL, resolveProfileEmail } from '../quota.js';
import type { TabContext } from './tab.js';
import { AccountsQuotaStore } from './accounts-quota.js';
import { initialAccountsState, type AccountsAction, type AccountsState } from './accounts-state.js';

interface AccountsEndpoint {
  mode?: 'pool' | 'single-account';
  accounts?: Array<{
    alias: string;
    expiresInMs?: number;
    expiresAt?: number;
    util5h?: number;
    util7d?: number;
    status?: string;
    enabled?: boolean;
    refreshError?: string;
    measuredAt?: number;
  }>;
}

export class AccountsController {
  private readonly quota = new AccountsQuotaStore();
  private refreshing = false;
  private addAbortController: AbortController | null = null;

  cancelAdd(): void {
    this.addAbortController?.abort(new Error('OAuth flow cancelled'));
  }

  async mount(ctx: TabContext<AccountsState>): Promise<AccountsState | undefined> {
    if (this.refreshing) return undefined;
    this.refreshing = true;
    try {
      const next = await loadAccounts(ctx, false, this.quota);
      ctx.setState((previous) => mergeLoadedState(previous, next));
      return undefined;
    } catch (error) {
      ctx.setState({
        loading: false,
        message: `Refresh failed: ${(error as Error).message}`,
        messageKind: 'error',
      });
      return undefined;
    } finally {
      this.refreshing = false;
    }
  }

  tick(state: AccountsState, ctx: TabContext<AccountsState>): void {
    const action = state.pendingAction;
    if (!action) return;
    ctx.setState({ pendingAction: null });
    this.run(action, ctx);
  }

  private run(action: AccountsAction, ctx: TabContext<AccountsState>): void {
    if (action.type === 'cancel-add') {
      this.cancelAdd();
      return;
    }
    if (action.type === 'refresh') {
      if (this.refreshing) return;
      this.refreshing = true;
      void (async () => {
        if (action.reconcile) await ctx.client.reconcilePool();
        return loadAccounts(ctx, action.forceQuota, this.quota);
      })()
        .then((next) => ctx.setState(next))
        .catch((error) => ctx.setState({
          loading: false,
          message: `Refresh failed: ${(error as Error).message}`,
          messageKind: 'error',
        }))
        .finally(() => { this.refreshing = false; });
      return;
    }
    if (action.type === 'add') {
      if (!this.addAbortController) void this.performAdd(ctx, action.alias);
      return;
    }
    if (action.type === 'delete') {
      void this.performDelete(ctx, action.alias, action.selectedIdx);
      return;
    }
    if (action.type === 'toggle') {
      void this.performToggle(ctx, action.alias, action.selectedIdx);
      return;
    }
    void this.performRename(ctx, action.oldAlias, action.newAlias);
  }

  private async performToggle(ctx: TabContext<AccountsState>, alias: string, selectedIdx: number): Promise<void> {
    try {
      const result = await ctx.client.toggleAccount(alias);
      if (!result?.ok) {
        ctx.setState({ message: `Failed to update "${alias}".`, messageKind: 'error', mode: 'normal' });
        return;
      }
      const next = await loadAccounts(ctx, false, this.quota);
      const nextSelectedIdx = Math.min(
        next.accounts.findIndex((account) => account.alias === alias),
        Math.max(0, next.accounts.length - 1),
      );
      ctx.setState({
        ...next,
        selectedIdx: nextSelectedIdx >= 0 ? nextSelectedIdx : Math.min(selectedIdx, Math.max(0, next.accounts.length - 1)),
        message: `Account "${alias}" ${result.enabled ? 'enabled' : 'disabled'}.`,
        messageKind: 'success',
      });
    } catch (error) {
      ctx.setState({ message: `Update failed: ${(error as Error).message}`, messageKind: 'error', mode: 'normal' });
    }
  }

  private async performAdd(ctx: TabContext<AccountsState>, inputAlias: string): Promise<void> {
    const abortController = new AbortController();
    this.addAbortController = abortController;
    let credentialsPersisted = false;
    try {
      const { listAccountAliases, addAccountViaOAuth } = await import('../accounts.js');
      const existing = await listAccountAliases();
      const taken = new Set(existing.map((alias) => alias.toLowerCase()));
      let alias = inputAlias;
      if (!alias) {
        for (let n = 1; ; n++) {
          const candidate = `account-${n}`;
          if (!taken.has(candidate.toLowerCase())) {
            alias = candidate;
            break;
          }
        }
      }

      const creds = await addAccountViaOAuth(alias, {
        signal: abortController.signal,
        onAuthorizeUrl: (authorizeUrl) => {
          ctx.setState({
            authorizeUrl,
            message: `Adding "${alias}" — complete sign-in in browser. (Esc to cancel)`,
            messageKind: 'info',
          });
        },
      });
      credentialsPersisted = true;
      abortController.signal.throwIfAborted();
      ctx.setState({
        mode: 'finishing',
        authorizeUrl: null,
        message: `Finalizing "${alias}"…`,
        messageKind: 'info',
      });

      if (creds.accessToken && !inputAlias) {
        try {
          const profileResponse = await fetch(CLAUDE_PROFILE_URL, {
            method: 'GET',
            headers: { authorization: `Bearer ${creds.accessToken}` },
            signal: AbortSignal.any([abortController.signal, AbortSignal.timeout(5000)]),
          });
          if (profileResponse.ok) {
            const profile = await profileResponse.json();
            const email = resolveProfileEmail(profile);
            const emailAlias = email?.replace(/@/g, '.').replace(/[^a-zA-Z0-9._-]/g, '') ?? '';
            if (isValidAccountAlias(emailAlias) && !taken.has(emailAlias.toLowerCase())) {
              const renamed = await ctx.client.renameAccount(alias, emailAlias);
              if (renamed?.ok) alias = emailAlias;
            }
          }
        } catch {
          // Profile naming is best-effort; the generated alias remains valid.
        }
      }

      abortController.signal.throwIfAborted();
      await ctx.client.reconcilePool();
      abortController.signal.throwIfAborted();
      const next = await loadAccounts(ctx, true, this.quota);
      abortController.signal.throwIfAborted();
      ctx.setState({
        ...next,
        message: `Account "${alias}" added.`,
        messageKind: 'success',
        editBuffer: null,
        authorizeUrl: null,
      });
    } catch (error) {
      if (abortController.signal.aborted) {
        // OAuth commits credentials before the optional profile lookup. If the
        // user cancels during that post-commit phase, reconcile anyway so the
        // live proxy does not wait for a restart to see the new account.
        if (credentialsPersisted) await ctx.client.reconcilePool().catch(() => {});
        return;
      }
      const message = (error as Error).message ?? String(error);
      const hint = /callback server|EADDRINUSE/i.test(message)
        ? ' Try from CLI: dario accounts add --manual'
        : /timed out/i.test(message) ? ' OAuth timed out — try again.' : '';
      ctx.setState({
        mode: 'normal',
        loading: false,
        message: `Add failed: ${message}${hint}`,
        messageKind: 'error',
        editBuffer: null,
        authorizeUrl: null,
      });
    } finally {
      if (this.addAbortController === abortController) this.addAbortController = null;
    }
  }

  private async performDelete(
    ctx: TabContext<AccountsState>,
    alias: string,
    selectedIdx: number,
  ): Promise<void> {
    try {
      const result = await ctx.client.removeAccount(alias);
      if (!result?.ok) {
        ctx.setState({ message: `Failed to remove "${alias}".`, messageKind: 'error', mode: 'normal' });
        return;
      }
      const next = await loadAccounts(ctx, false, this.quota);
      ctx.setState({
        ...next,
        selectedIdx: Math.min(selectedIdx, Math.max(0, next.accounts.length - 1)),
        message: `Removed "${alias}".`,
        messageKind: 'success',
      });
    } catch (error) {
      ctx.setState({ message: `Delete failed: ${(error as Error).message}`, messageKind: 'error', mode: 'normal' });
    }
  }

  private async performRename(
    ctx: TabContext<AccountsState>,
    oldAlias: string,
    newAlias: string,
  ): Promise<void> {
    if (!isValidAccountAlias(newAlias)) {
      ctx.setState({
        message: 'Invalid alias — start with a letter or number; maximum 64 characters.',
        messageKind: 'error',
        editBuffer: null,
      });
      return;
    }
    if (oldAlias === newAlias) {
      ctx.setState({ message: null, messageKind: null, editBuffer: null });
      return;
    }
    try {
      const result = await ctx.client.renameAccount(oldAlias, newAlias);
      if (!result?.ok) {
        ctx.setState({ message: 'Rename failed.', messageKind: 'error', editBuffer: null });
        return;
      }
      const next = await loadAccounts(ctx, false, this.quota);
      ctx.setState({
        ...next,
        message: `Renamed "${oldAlias}" → "${newAlias}".`,
        messageKind: 'success',
        editBuffer: null,
      });
    } catch (error) {
      ctx.setState({ message: `Rename failed: ${(error as Error).message}`, messageKind: 'error', editBuffer: null });
    }
  }
}

function mergeLoadedState(previous: AccountsState, next: AccountsState): AccountsState {
  const interactionActive = previous.mode !== 'normal'
    || previous.editBuffer !== null
    || previous.pendingAction !== null;
  if (!interactionActive) return next;
  return {
    ...next,
    selectedIdx: Math.min(previous.selectedIdx, Math.max(0, next.accounts.length - 1)),
    mode: previous.mode,
    editBuffer: previous.editBuffer,
    message: previous.message,
    messageKind: previous.messageKind,
    authorizeUrl: previous.authorizeUrl,
    pendingAction: previous.pendingAction,
  };
}

const standaloneQuota = new AccountsQuotaStore();

export async function refreshAccounts(
  ctx?: TabContext<AccountsState>,
  forceQuotaRefresh = false,
): Promise<AccountsState> {
  return loadAccounts(ctx, forceQuotaRefresh, standaloneQuota);
}

async function loadAccounts(
  ctx: TabContext<AccountsState> | undefined,
  forceQuotaRefresh: boolean,
  quotaStore: AccountsQuotaStore,
): Promise<AccountsState> {
  if (!ctx) return diskFallback();
  try {
    const response = await ctx.client.getJson<AccountsEndpoint>('/accounts');
    if (response.mode === 'single-account') {
      return { ...initialAccountsState(), loading: false, source: 'single-account' };
    }
    if (Array.isArray(response.accounts)) {
      const now = Date.now();
      const quota = await quotaStore.fetch(ctx.client, forceQuotaRefresh);
      return {
        ...initialAccountsState(),
        loading: false,
        source: 'pool',
        accounts: response.accounts.map((account) => ({
          alias: account.alias,
          expiresAt: account.expiresAt ?? now + (account.expiresInMs ?? 0),
          util5h: account.util5h,
          util7d: account.util7d,
          status: account.status,
          enabled: account.enabled !== false,
          refreshError: account.refreshError,
          measuredAt: account.measuredAt,
          ...(quota.entries.has(account.alias) ? { quota: quota.entries.get(account.alias)! } : {}),
        })),
        message: quota.warning,
        messageKind: quota.warning ? 'warning' : null,
      };
    }
  } catch {
    return diskFallback();
  }
  return diskFallback();
}

async function diskFallback(): Promise<AccountsState> {
  try {
    const { listAccountAliases, loadAllAccounts } = await import('../accounts.js');
    const aliases = await listAccountAliases();
    if (aliases.length === 0) return { ...initialAccountsState(), loading: false, source: 'disk' };
    const accounts = await loadAllAccounts();
    return {
      ...initialAccountsState(),
      loading: false,
      source: 'disk',
      accounts: accounts.map((account) => ({ alias: account.alias, expiresAt: account.expiresAt, enabled: account.enabled !== false })),
    };
  } catch (error) {
    return {
      ...initialAccountsState(),
      loading: false,
      source: 'disk',
      error: (error as Error).message,
    };
  }
}
