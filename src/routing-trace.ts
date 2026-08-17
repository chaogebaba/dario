import { createHash, randomBytes } from 'node:crypto';

import type { RoutingCandidateDiagnostic, RoutingPoolDiagnostic, PoolStrategy } from './pool.js';

export type AffinityResult = 'hit' | 'new' | 'rebind' | 'none' | 'disabled';
export type RoutingSelectionReason =
  | 'affinity-hit'
  | 'affinity-new'
  | 'affinity-rebind'
  | 'affinity-disabled'
  | PoolStrategy
  | 'no-eligible-account';
export type RoutingReleaseReason = 'timeout' | 'network' | 'upstream-5xx' | 'terminal-429' | 'terminal-auth';

export interface RoutingAffinityDiagnostic {
  enabled: boolean;
  source: string | null;
  fingerprint: string | null;
  bindingBefore: string | null;
  result: AffinityResult;
}

export interface RoutingFailoverDiagnostic {
  at: string;
  from: string;
  to: string;
  status: number;
  reason: 'rate-limit' | 'auth';
}

export interface RoutingTraceEvent {
  ts: string;
  req: number;
  method: string;
  path: string;
  model: string | null;
  family: string | null;
  strategy: PoolStrategy;
  affinity: RoutingAffinityDiagnostic;
  cursor: { before: string | null; after: string | null };
  initialSelected: string | null;
  selected: string | null;
  selectionReason: RoutingSelectionReason;
  candidates: RoutingCandidateDiagnostic[];
  failovers: RoutingFailoverDiagnostic[];
  released: RoutingReleaseReason | null;
  status: number | null;
  latencyMs: number | null;
}

export interface RoutingTraceReport {
  generatedAt: string;
  capacity: number;
  retained: number;
  pool: RoutingPoolDiagnostic;
  diagnosis: {
    dominantCause: 'no-traffic' | 'single-affinity-key' | 'single-eligible-account' | 'account-skew' | 'balanced';
    summary: string;
  };
  counts: {
    selected: Record<string, number>;
    affinity: Record<string, number>;
    affinityResults: Record<string, number>;
    selectionReasons: Record<string, number>;
    statuses: Record<string, number>;
  };
  events: RoutingTraceEvent[];
}

export interface RoutingTraceStart {
  req: number;
  method: string;
  path: string;
  model: string | null;
  family: string | null;
  stickyKey: string | null;
  bindingBefore: string | null;
  before: RoutingPoolDiagnostic;
  after: RoutingPoolDiagnostic;
  selected: string | null;
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

export function describeAffinity(stickyKey: string | null, salt: string | Buffer = ''): { source: string | null; fingerprint: string | null } {
  if (!stickyKey) return { source: null, fingerprint: null };
  const separator = stickyKey.indexOf(':');
  const rawSource = separator > 0 ? stickyKey.slice(0, separator) : 'derived';
  const source = /^[a-z0-9-]{1,32}$/i.test(rawSource) ? rawSource.toLowerCase() : 'derived';
  return {
    source,
    // The per-process salt lets an agent correlate one live trace without
    // making fingerprints stable across restarts or guessable from low-entropy
    // client identifiers.
    fingerprint: createHash('sha256').update(salt).update(stickyKey).digest('hex').slice(0, 12),
  };
}

export function affinityResult(
  enabled: boolean,
  stickyKey: string | null,
  bindingBefore: string | null,
  selected: string | null,
): AffinityResult {
  if (!enabled) return 'disabled';
  if (!stickyKey) return 'none';
  if (!bindingBefore) return 'new';
  return bindingBefore === selected ? 'hit' : 'rebind';
}

function selectionReason(result: AffinityResult, selected: string | null, strategy: PoolStrategy): RoutingSelectionReason {
  if (!selected) return 'no-eligible-account';
  if (result === 'hit') return 'affinity-hit';
  if (result === 'new') return 'affinity-new';
  if (result === 'rebind') return 'affinity-rebind';
  if (result === 'disabled') return 'affinity-disabled';
  return strategy;
}

export class RoutingTraceHandle {
  private completed = false;

  constructor(
    private readonly event: RoutingTraceEvent,
    private readonly complete: (event: RoutingTraceEvent) => void,
  ) {}

  failover(to: string, status: number, reason: 'rate-limit' | 'auth'): void {
    const from = this.event.selected;
    if (!from || from === to) return;
    this.event.failovers.push({ at: new Date().toISOString(), from, to, status, reason });
    this.event.selected = to;
  }

  release(reason: RoutingReleaseReason): void {
    this.event.released = reason;
  }

  finish(status: number, latencyMs: number): void {
    if (this.completed) return;
    this.event.status = status;
    this.event.latencyMs = Math.max(0, Math.round(latencyMs));
    this.completed = true;
    this.complete(this.event);
  }
}

export class RoutingTraceStore {
  readonly capacity: number;
  private readonly events: RoutingTraceEvent[] = [];
  private readonly salt = randomBytes(16);

  constructor(capacity = 256) {
    this.capacity = Math.max(1, Math.min(4096, Math.floor(capacity) || 256));
  }

  start(input: RoutingTraceStart): RoutingTraceHandle {
    const described = describeAffinity(input.stickyKey, this.salt);
    const result = affinityResult(
      input.before.sessionAffinity.enabled,
      input.stickyKey,
      input.bindingBefore,
      input.selected,
    );
    const event: RoutingTraceEvent = {
      ts: new Date().toISOString(),
      req: input.req,
      method: input.method,
      path: input.path,
      model: input.model,
      family: input.family,
      strategy: input.before.strategy,
      affinity: {
        enabled: input.before.sessionAffinity.enabled,
        ...described,
        bindingBefore: input.bindingBefore,
        result,
      },
      cursor: { before: input.before.cursor, after: input.after.cursor },
      initialSelected: input.selected,
      selected: input.selected,
      selectionReason: selectionReason(result, input.selected, input.before.strategy),
      candidates: input.before.candidates.map((candidate) => ({
        ...candidate,
        cooldowns: candidate.cooldowns.map((cooldown) => ({ ...cooldown })),
      })),
      failovers: [],
      released: null,
      status: null,
      latencyMs: null,
    };
    return new RoutingTraceHandle(event, (completed) => {
      this.events.push(completed);
      if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    });
  }

  report(pool: RoutingPoolDiagnostic, requestedLimit = 50): RoutingTraceReport {
    const limit = Math.max(1, Math.min(this.capacity, Math.floor(requestedLimit) || 50));
    const events = this.events.slice(-limit).reverse().map((event) => structuredClone(event));
    const counts = {
      selected: {} as Record<string, number>,
      affinity: {} as Record<string, number>,
      affinityResults: {} as Record<string, number>,
      selectionReasons: {} as Record<string, number>,
      statuses: {} as Record<string, number>,
    };
    for (const event of events) {
      increment(counts.selected, event.selected ?? 'none');
      if (event.affinity.fingerprint) increment(counts.affinity, event.affinity.fingerprint);
      increment(counts.affinityResults, event.affinity.result);
      increment(counts.selectionReasons, event.selectionReason);
      increment(counts.statuses, event.status === null ? 'in-flight' : String(event.status));
    }

    return {
      generatedAt: new Date().toISOString(),
      capacity: this.capacity,
      retained: this.events.length,
      pool,
      diagnosis: diagnoseRouting(events, pool),
      counts,
      events,
    };
  }
}

export function diagnoseRouting(
  events: RoutingTraceEvent[],
  pool: RoutingPoolDiagnostic,
): RoutingTraceReport['diagnosis'] {
  if (events.length === 0) {
    return { dominantCause: 'no-traffic', summary: 'No pool routing decisions are retained yet.' };
  }

  const affinityCounts = new Map<string, number>();
  for (const event of events) {
    if (event.affinity.fingerprint) {
      affinityCounts.set(event.affinity.fingerprint, (affinityCounts.get(event.affinity.fingerprint) ?? 0) + 1);
    }
  }
  const dominantAffinity = [...affinityCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (pool.sessionAffinity.enabled && dominantAffinity && dominantAffinity[1] >= 2 && dominantAffinity[1] / events.length >= 0.75) {
    const selected = events.find((event) => event.affinity.fingerprint === dominantAffinity[0])?.selected ?? 'one account';
    return {
      dominantCause: 'single-affinity-key',
      summary: `${dominantAffinity[1]}/${events.length} requests reused affinity ${dominantAffinity[0]} and were intentionally pinned to ${selected}. Round-robin applies when a new affinity key is bound.`,
    };
  }

  const eligibleAliases = pool.candidates.filter((candidate) => candidate.selectionEligible).map((candidate) => candidate.alias);
  if (eligibleAliases.length <= 1) {
    const detail = eligibleAliases.length === 1 ? eligibleAliases[0] : 'none';
    return {
      dominantCause: 'single-eligible-account',
      summary: `Only ${detail} is currently eligible; rotation needs at least two eligible accounts.`,
    };
  }

  const selectedCounts = new Map<string, number>();
  for (const event of events) {
    if (event.selected) selectedCounts.set(event.selected, (selectedCounts.get(event.selected) ?? 0) + 1);
  }
  const dominantAccount = [...selectedCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (dominantAccount && dominantAccount[1] / events.length >= 0.8) {
    return {
      dominantCause: 'account-skew',
      summary: `${dominantAccount[0]} handled ${dominantAccount[1]}/${events.length} retained requests. Inspect affinity results, candidate reasons, and failovers below.`,
    };
  }

  return {
    dominantCause: 'balanced',
    summary: `Traffic is distributed across ${selectedCounts.size} accounts in the retained window.`,
  };
}
