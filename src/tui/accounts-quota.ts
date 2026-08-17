import type { ProxyClient } from './proxy-client.js';
import type { AccountQuota } from './accounts-state.js';
import type { QuotaWindow } from '../quota.js';

interface QuotaEndpoint {
  accounts?: Array<{
    alias: string;
    windows?: QuotaWindow[];
    plan?: string | null;
    email?: string | null;
    error?: string;
  }>;
}

export interface QuotaResult {
  entries: Map<string, AccountQuota>;
  warning: string | null;
}

export function mergeQuotaEntries(
  cached: Map<string, AccountQuota>,
  fresh: Map<string, AccountQuota>,
): { cache: Map<string, AccountQuota>; display: Map<string, AccountQuota>; usedStale: boolean } {
  const cache = new Map<string, AccountQuota>();
  const display = new Map(fresh);
  let usedStale = false;
  for (const [alias, entry] of fresh) {
    if (!entry.error && entry.windows.length > 0) {
      cache.set(alias, entry);
    } else if (cached.has(alias)) {
      const stale = cached.get(alias)!;
      cache.set(alias, stale);
      display.set(alias, stale);
      usedStale = true;
    }
  }
  return { cache, display, usedStale };
}

export class AccountsQuotaStore {
  private lastGood = new Map<string, AccountQuota>();

  async fetch(client: ProxyClient, force: boolean): Promise<QuotaResult> {
    const fresh = new Map<string, AccountQuota>();
    try {
      const response = await client.getJson<QuotaEndpoint>(force ? '/quota?refresh=1' : '/quota');
      for (const account of response.accounts ?? []) {
        fresh.set(account.alias, {
          windows: account.windows ?? [],
          plan: account.plan ?? null,
          email: account.email ?? null,
          ...(account.error ? { error: account.error } : {}),
        });
      }
      const merged = mergeQuotaEntries(this.lastGood, fresh);
      this.lastGood = merged.cache;
      if (!merged.usedStale) return { entries: merged.display, warning: null };
      const firstError = response.accounts?.find((account) => account.error)?.error ?? 'unknown';
      return {
        entries: merged.display,
        warning: `Quota API rate-limited (${firstError}) — showing cached data.`,
      };
    } catch {
      return { entries: fresh, warning: null };
    }
  }
}
