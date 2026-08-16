// Optional egress-proxy routing for upstream API calls. Behind
// `--egress-proxy=URL` (aliases: `--upstream-proxy`, `--via`) or
// `DARIO_EGRESS_PROXY`, dario routes all of its outbound fetch() calls —
// `api.anthropic.com`, configured OpenAI-compat backends, OAuth flows,
// drift checks, doctor probes — through the supplied proxy. Localhost-bound
// fetches bypass it (the inbound HTTP server is unaffected; this only
// wraps egress).
//
// Use case: security-conscious users who want dario's upstream traffic
// routed through their VPN provider's proxy endpoint without putting the
// entire host on a system-level VPN. Pair with the HTTP or SOCKS5 mode of
// Mullvad / AirVPN / a local privoxy-on-Tor / corporate proxy
// infrastructure / Cloudflare WARP via gateway / etc.
//
// Runtime constraints:
//   - Requires Bun. Bun's fetch implements the `proxy` option natively;
//     Node's built-in fetch (undici-backed) ignores it silently and
//     would yield a misleading "looks like it's working" failure mode.
//   - http:/https: proxies are handed straight to Bun's fetch.
//   - socks5:/socks5h: are not understood by Bun's fetch, so dario runs
//     an in-process loopback CONNECT bridge that speaks SOCKS5 upstream
//     (src/socks5-bridge.ts) and points fetch at that. TLS still
//     originates in Bun and terminates at the origin.
//   - socks4/socks4a are not supported: no authentication, no IPv6, and
//     no remote DNS in socks4. Use socks5h.
//
// Wire-fidelity note: the proxy sits *outside* the TLS session — TLS
// to api.anthropic.com terminates at Anthropic, not at the proxy.
// Bun's BoringSSL ClientHello is preserved end-to-end. The only thing
// the proxy can see in HTTPS-CONNECT mode is the destination hostname
// (via SNI) and the byte timing.

import { startSocks5Bridge, type Socks5Bridge } from './socks5-bridge.js';

export type EgressProxyScheme = 'http' | 'https' | 'socks5' | 'socks5h';

export interface OutboundProxyConfig {
  /** Original URL string supplied by the user. Passed verbatim to fetch's `proxy` option for http/https. */
  url: string;
  /** Parsed scheme. */
  scheme: EgressProxyScheme;
  /** Sanitized URL for logging — credentials redacted. */
  display: string;
  /** Present for socks5/socks5h: the details the bridge needs to dial. */
  socks?: {
    host: string;
    port: number;
    username?: string;
    password?: string;
    /** socks5h → resolve destination at the proxy; socks5 → resolve locally. */
    remoteDns: boolean;
  };
}

/**
 * Strip userinfo from a proxy URL that may not parse.
 *
 * `display` only exists once `new URL()` has succeeded, so the one error
 * that reports a *parse failure* is also the one that cannot use it — and
 * that error is echoed to stderr, into `dario doctor --json`, and into the
 * TUI status bar. An egress proxy URL routinely carries a residential
 * proxy password, and a parse failure (a typo'd port, say) is exactly when
 * an operator pastes the output into a bug report.
 */
export function redactProxyUrl(raw: string): string {
  return raw.replace(/^([a-z0-9+.-]+:\/\/)[^/?#@]*@/i, '$1***:***@');
}

/**
 * Parse and validate an egress-proxy URL. Returns null for empty/undefined
 * input (no proxy configured). Throws with a clear message on:
 *   - URL parse failure
 *   - socks4/socks4a (obsolete; no auth, no IPv6, no remote DNS)
 *   - Other unsupported schemes
 *   - SOCKS URLs carrying a path/query/fragment (meaningless — likely a typo)
 *
 * Every thrown message is safe to paste into a bug report.
 */
export function parseOutboundProxy(raw: string | undefined): OutboundProxyConfig | null {
  if (!raw || raw.trim() === '') return null;

  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error(
      `--egress-proxy: ${JSON.stringify(redactProxyUrl(raw.trim()))} is not a valid URL. Expected http://host:port, https://host:port, socks5h://host:port, or socks5://host:port.`,
    );
  }

  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();

  if (scheme === 'socks4' || scheme === 'socks4a' || scheme === 'socks') {
    throw new Error(
      `--egress-proxy: ${JSON.stringify(scheme)} is not supported — SOCKS4 has no authentication, no IPv6, and no remote DNS. ` +
      `Use socks5h:// (resolves the destination at the proxy) or socks5:// (resolves locally).`,
    );
  }

  const isSocks = scheme === 'socks5' || scheme === 'socks5h';

  if (scheme !== 'http' && scheme !== 'https' && !isSocks) {
    throw new Error(
      `--egress-proxy: unsupported scheme ${JSON.stringify(scheme)}. Use http://, https://, socks5h://, or socks5://.`,
    );
  }

  // Sanitize for logging: hide username/password if embedded in URL.
  const display = (() => {
    if (!parsed.username && !parsed.password) return parsed.toString();
    const safe = new URL(parsed.toString());
    if (safe.username) safe.username = '***';
    if (safe.password) safe.password = '***';
    return safe.toString();
  })();

  if (!isSocks) {
    return { url: parsed.toString(), scheme: scheme as 'http' | 'https', display };
  }

  // ── SOCKS5 ───────────────────────────────────────────────────
  // A path/query/fragment on a SOCKS URL has no meaning. Silently
  // ignoring one hides typos like socks5h://host:1080/api, so reject.
  // Note `new URL('socks5h://h:1')` normalizes pathname to '' (not '/')
  // for non-special schemes, so a bare host stays clean.
  if ((parsed.pathname && parsed.pathname !== '' && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new Error(
      `--egress-proxy: SOCKS URLs take only host, port, and optional credentials — ` +
      `drop the path/query from ${JSON.stringify(display)}.`,
    );
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!host) {
    throw new Error(`--egress-proxy: ${JSON.stringify(display)} is missing a host.`);
  }
  const port = parsed.port ? Number(parsed.port) : 1080;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`--egress-proxy: ${JSON.stringify(parsed.port)} is not a valid port.`);
  }

  return {
    url: parsed.toString(),
    scheme: scheme as 'socks5' | 'socks5h',
    display,
    socks: {
      host,
      port,
      // URL percent-encodes credentials; decode for the wire.
      username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      remoteDns: scheme === 'socks5h',
    },
  };
}


/**
 * Heuristic check: does this URL target localhost / loopback?
 * Used to skip the proxy wrapper for self-targeting fetches (doctor
 * pings the local server, etc.). Lenient on parse errors — anything
 * unparseable returns false (proxied as a bare hostname, conservatively).
 */
export function isLocalhostUrl(input: unknown): boolean {
  if (input === null || input === undefined) return false;
  let urlStr: string;
  if (typeof input === 'string') {
    urlStr = input;
  } else if (input instanceof URL) {
    urlStr = input.toString();
  } else if (typeof input === 'object' && 'url' in (input as Record<string, unknown>)) {
    const u = (input as { url?: unknown }).url;
    urlStr = typeof u === 'string' ? u : '';
  } else {
    return false;
  }
  if (!urlStr) return false;
  try {
    const parsed = new URL(urlStr);
    // URL.hostname for IPv6 includes the brackets ([::1]); strip for matching.
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
    if (host.endsWith('.localhost')) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Install a global fetch wrapper that adds `{ proxy }` to outbound
 * (non-localhost) calls. Idempotent over a single dario startup —
 * called once from cli.ts before startProxy.
 *
 * Refuses to install on non-Bun runtimes because Node's built-in fetch
 * silently ignores the proxy option, which would yield false-success
 * behavior (requests appearing to route through the proxy when they
 * actually go direct). Better to fail loud at startup than fail silent
 * at request time.
 */
export function installOutboundProxyWrapper(config: OutboundProxyConfig, proxyUrl?: string): void {
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
  if (!isBun) {
    throw new Error(
      `--egress-proxy requires the Bun runtime. Node's built-in fetch ignores the \`proxy\` option silently — ` +
      `the flag would appear to work while requests actually went direct. Install Bun (https://bun.sh); ` +
      `dario requires it.`,
    );
  }

  // For SOCKS the effective proxy is the loopback bridge, not the user's
  // URL — Bun's fetch cannot speak SOCKS itself.
  const effective = proxyUrl ?? config.url;

  const originalFetch = globalThis.fetch;
  // Wrap. Localhost targets bypass the proxy (loopback shouldn't tunnel).
  // The wrapper preserves originalFetch's behavior for everything else
  // and adds the `proxy` field. Bun honors it; the rest of the args
  // (headers, body, signal, dispatcher, etc.) pass through unchanged.
  const wrapped: typeof fetch = ((input, init) => {
    if (isLocalhostUrl(input)) {
      return originalFetch(input as Parameters<typeof fetch>[0], init);
    }
    // Use a typed cast — Bun's fetch options include `proxy`, but TS's
    // standard fetch types don't.
    const bunInit = { ...(init || {}), proxy: effective } as Parameters<typeof fetch>[1];
    return originalFetch(input as Parameters<typeof fetch>[0], bunInit);
  }) as typeof fetch;
  globalThis.fetch = wrapped;
}

/**
 * Install egress routing for a parsed config, starting the SOCKS5 bridge
 * first when one is needed. Returns the bridge so the caller can close it
 * on shutdown (null for http/https, which need no helper process).
 *
 * This is the entry point cli.ts uses; `installOutboundProxyWrapper` stays
 * exported for the http/https-only path and for tests.
 */
export async function installEgressProxy(config: OutboundProxyConfig): Promise<Socks5Bridge | null> {
  if (!config.socks) {
    installOutboundProxyWrapper(config);
    return null;
  }
  const bridge = await startSocks5Bridge(config.socks);
  // proxyUrl, not url: the bridge requires a per-process token so no
  // other local process can relay through the operator's SOCKS5 proxy.
  installOutboundProxyWrapper(config, bridge.proxyUrl);
  return bridge;
}
