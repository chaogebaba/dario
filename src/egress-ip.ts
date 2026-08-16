// What IP does the far side actually see?
//
// Every check dario can run locally — the URL parsed, the bridge bound,
// the SOCKS5 handshake completed — is also consistent with traffic still
// leaving by the default route. A proxy that accepts CONNECT and then
// forwards from the host's own address looks identical from inside the
// process. Only asking a remote endpoint settles it, which is why this
// exists and why a failure is treated as fatal at startup rather than as
// a warning: the failure mode being guarded is "my subscription traffic
// silently went out my home IP", and that one is not recoverable after
// the fact.
//
// The probe deliberately goes through globalThis.fetch, which by the time
// it runs is already wrapped by installEgressProxy. It therefore measures
// dario's real egress path rather than a parallel one that could differ.

import { isIP } from 'node:net';

/**
 * Cloudflare's trace endpoint. Plain text, no key, no quota worth
 * worrying about, and already in the request path for a large fraction
 * of the internet — asking it reveals nothing it could not already see.
 * Override with DARIO_EGRESS_IP_URL or config `egressIpUrl` for anyone
 * who would rather point at their own endpoint.
 */
export const DEFAULT_EGRESS_IP_URL = 'https://cloudflare.com/cdn-cgi/trace';

export interface EgressIpResult {
  ok: boolean;
  /** The address the endpoint reported, or null when the probe failed. */
  ip: string | null;
  /** Endpoint that was asked. */
  url: string;
  checkedAt: number;
  latencyMs: number;
  /** Operator-legible failure reason. Never contains credentials. */
  error?: string;
}

/** Resolve the probe endpoint: env > config file > default. */
export function egressIpUrl(
  env: Record<string, string | undefined>,
  fileValue?: string | null,
): string {
  const fromEnv = env['DARIO_EGRESS_IP_URL'];
  if (fromEnv !== undefined) return fromEnv.trim() || DEFAULT_EGRESS_IP_URL;
  const fromFile = fileValue?.trim();
  return fromFile || DEFAULT_EGRESS_IP_URL;
}

/**
 * Pull an address out of whatever the endpoint returned.
 *
 * Tolerant on purpose: the default is Cloudflare's `key=value` trace, but
 * an operator pointing DARIO_EGRESS_IP_URL at ifconfig.me/ip or a JSON
 * echo service should not have to care. Everything is validated through
 * isIP, so a captive portal's HTML login page yields null rather than a
 * confident-looking string.
 */
export function parseEgressIp(body: string): string | null {
  const text = body.trim();
  if (!text) return null;

  // cdn-cgi/trace: `fl=...`, `ip=...`, one per line.
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0 && line.slice(0, eq).trim() === 'ip') {
      const v = line.slice(eq + 1).trim();
      if (isIP(v)) return v;
    }
  }

  // A bare address (ifconfig.me/ip, icanhazip.com).
  if (isIP(text)) return text;

  // JSON echo services: {"ip": ...} / {"origin": ...} / {"address": ...}.
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      for (const key of ['ip', 'origin', 'address']) {
        const v = obj[key];
        // httpbin's `origin` can be a comma-joined forwarded chain.
        if (typeof v === 'string') {
          const first = v.split(',')[0]!.trim();
          if (isIP(first)) return first;
        }
      }
    } catch { /* not JSON after all */ }
  }

  return null;
}

/**
 * Ask the endpoint what address it sees. Never throws — a failed probe is
 * a result, because the caller's job is to report it, not to crash on it.
 *
 * `fetchImpl` defaults to the live `globalThis.fetch`, which by the time
 * this runs is the proxy-wrapped one. Pass the pre-wrap fetch to measure
 * the *direct* route instead — that comparison is what turns "the proxy
 * answered" into "the proxy actually changed where I come from".
 */
export async function checkEgressIp(
  url: string,
  timeoutMs = 8_000,
  fetchImpl?: typeof fetch,
): Promise<EgressIpResult> {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const started = Date.now();
  const base = { url, checkedAt: started };
  try {
    const res = await doFetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'dario-egress-check' },
      redirect: 'follow',
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      // A proxy failure usually arrives as a status, not a thrown error —
      // the loopback bridge answers 502 with the SOCKS reason in the body,
      // and an HTTP proxy does much the same. Dropping the body would
      // leave the operator with a bare "502" for a connection refused.
      const detail = await res.text()
        .then((t) => t.replace(/\s+/g, ' ').trim().slice(0, 160))
        .catch(() => '');
      return {
        ...base,
        ok: false,
        ip: null,
        latencyMs,
        error: `${url} answered HTTP ${res.status}${detail ? ` — ${detail}` : ''}`,
      };
    }
    const ip = parseEgressIp(await res.text());
    if (!ip) {
      return { ...base, ok: false, ip: null, latencyMs, error: `${url} returned no recognisable IP address` };
    }
    return { ...base, ok: true, ip, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const e = err as Error & { cause?: { code?: string } };
    const detail = e.name === 'TimeoutError' || e.name === 'AbortError'
      ? `no response within ${timeoutMs}ms`
      : (e.cause?.code ?? e.message);
    return { ...base, ok: false, ip: null, latencyMs, error: `could not reach ${url} — ${detail}` };
  }
}

// ── Process-wide snapshot ────────────────────────────────────────────
// The egress route is a property of the process, exactly like the fetch
// wrapper that implements it, so it is held the same way rather than
// threaded through every call site that wants to report on it.

export interface EgressSnapshot {
  /** Credential-redacted proxy URL, or null when routing direct. */
  proxy: string | null;
  /** 'http' | 'https' | 'socks5' | 'socks5h', or null when direct. */
  scheme: string | null;
  /** Resolved probe endpoint, so re-checks need no config plumbing. */
  probeUrl: string;
  last: EgressIpResult | null;
  /**
   * What the same endpoint reported over the *unproxied* route at startup,
   * when that baseline was taken. Equal to `last.ip` means the proxy is
   * accepting traffic and forwarding it from this host's own address —
   * a working-looking route that hides nothing.
   */
  directIp: string | null;
}

const snapshot: EgressSnapshot = {
  proxy: null,
  scheme: null,
  probeUrl: DEFAULT_EGRESS_IP_URL,
  last: null,
  directIp: null,
};
let refreshing = false;

export function setEgressRoute(proxy: string | null, scheme: string | null, probeUrl: string): void {
  snapshot.proxy = proxy;
  snapshot.scheme = scheme;
  snapshot.probeUrl = probeUrl;
}

export function recordEgressCheck(result: EgressIpResult): void {
  snapshot.last = result;
}

/** Remember the unproxied address, so later reports can compare against it. */
export function recordDirectIp(ip: string | null): void {
  snapshot.directIp = ip;
}

/**
 * True when the proxy is up but egressing from this host's own address.
 * Only meaningful once a baseline has been taken; without one this is
 * false, because "unknown" must not read as "leaking".
 */
export function egressIsNotChangingIp(s: EgressSnapshot): boolean {
  return Boolean(s.proxy && s.directIp && s.last?.ok && s.last.ip === s.directIp);
}

export function getEgressSnapshot(): EgressSnapshot {
  return { ...snapshot, last: snapshot.last ? { ...snapshot.last } : null };
}

/**
 * Serve the cached result and refresh in the background when it has gone
 * stale. Callers (/health, the TUI) get an answer immediately; the probe
 * never sits in a request's latency path, and concurrent callers collapse
 * onto one in-flight refresh.
 */
export function refreshEgressIpIfStale(maxAgeMs = 300_000): void {
  if (refreshing) return;
  const last = snapshot.last;
  if (last && Date.now() - last.checkedAt < maxAgeMs) return;
  refreshing = true;
  void checkEgressIp(snapshot.probeUrl)
    .then(recordEgressCheck)
    .finally(() => { refreshing = false; });
}

/** Test hook — drops the cached result and the in-flight guard. */
export function resetEgressSnapshot(): void {
  snapshot.proxy = null;
  snapshot.scheme = null;
  snapshot.probeUrl = DEFAULT_EGRESS_IP_URL;
  snapshot.last = null;
  snapshot.directIp = null;
  refreshing = false;
}
