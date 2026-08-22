// Voice dictation WebSocket relay.
//
// Claude Code's voice mode opens a WebSocket to
// `/api/ws/speech_to_text/voice_stream`. The base for that URL is NOT
// `ANTHROPIC_BASE_URL` — it comes from CC's OAuth config, which is hardcoded to
// api.anthropic.com and overridable only against a three-host first-party
// allowlist dario is not on. So voice has never been broken behind dario; it
// bypasses dario entirely and goes straight to Anthropic bearing the user's own
// OAuth access token. That is the thing this module fixes: the one credential a
// dario user routes everything else through the proxy to avoid exposing was
// leaving the box on its own socket.
//
// The one lever that redirects it is an environment variable CC reads verbatim,
// with no allowlist:
//
//   VOICE_STREAM_BASE_URL=ws://127.0.0.1:8787 claude
//
// Two gates stay client-side and dario cannot move them: voice is unavailable
// when CC resolves its credentials from `ANTHROPIC_API_KEY` or an apiKeyHelper,
// and `allow_voice_mode` is a remote gate. See docs in README.
//
// The relay is blind. dario swaps the Authorization header for a pool token,
// dials Anthropic, hands back the 101, and then moves bytes. It never parses a
// WebSocket frame, so permessage-deflate negotiation, fragmentation, ping/pong
// and any future frame type pass through untouched, and a change to the
// transcript vocabulary does not need a dario release. The cost is that dario
// can see nothing: no transcripts, no usage, no rate-limit signal. A socket
// gets a close-time log line and no analytics RequestRecord — a fabricated
// zero-token record would only pollute the summary.
//
// Outbound leg is `node:https`, deliberately. dario's usual wire-fidelity rule
// says keep TLS on the stack Bun's `fetch` uses (see runtime-fingerprint.ts and
// the header of socks5-bridge.ts), but that rule exists to match what CC emits
// on the inference path, and CC emits the inference path through `fetch`. CC
// emits the VOICE socket through the npm `ws` client, which is `node:https`.
// Measured on Bun 1.4.0 by capturing the raw ClientHello of each client against
// a local listener and computing JA3:
//
//   fetch          d871d02cecbde59abbf8f4806134addf  (+ALPN, status_request, SCT)
//   node:https     71dc8c533dd919ae9f4963224a4ba8fd  ← what `ws` sends
//   Bun.connect    203503b7023848ab87b9836c336b8e81  (differs in cipher order)
//
// All three are the same BoringSSL. Using `node:https` here is not a fidelity
// regression, it is the only one of the three that matches CC. The hello is
// stable across runs and unaffected by the request headers or `servername`.
//
// Known gap, deliberate and loud: `--egress-proxy` is implemented by wrapping
// `globalThis.fetch` (outbound-proxy.ts), so a `node:https` dial would ignore
// it and go direct. An operator who configured egress routing on purpose must
// not get a silent bypass on one socket, so the relay declines instead.

import type { Server, IncomingMessage, RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { pipeline, type Duplex } from 'node:stream';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

/** The only path this relay will upgrade. Anything else is refused. */
export const VOICE_WS_PATH = '/api/ws/speech_to_text/voice_stream';

/** Bound on the upstream dial + handshake, in ms. */
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * Request headers copied to the upstream upgrade verbatim.
 *
 * Allowlist, not a denylist, for the same reason resolveProxyTarget is one: an
 * OAuth-bearing relay must not forward whatever a local caller decides to
 * attach. `authorization` is deliberately absent — it is replaced, never
 * forwarded, so a client's own token can never reach Anthropic through dario.
 *
 * The four CC identity headers were read out of the 2.1.237 bundle:
 *   { Authorization, "User-Agent": uDe(), "x-app": "cli",
 *     "anthropic-client-platform": VF() }  plus optional "x-config-keyterms".
 * The sec-websocket-* family is the handshake itself; dropping
 * `sec-websocket-key` would make the upstream's Sec-WebSocket-Accept wrong for
 * the client that is about to read it.
 */
export const FORWARDED_UPGRADE_HEADERS: readonly string[] = [
  'user-agent',
  'x-app',
  'anthropic-client-platform',
  'x-config-keyterms',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
  'upgrade',
  'connection',
];

/** The account a voice socket is billed to. */
export interface VoiceAccount {
  alias: string;
  accessToken: string;
}

export interface VoiceRelayDeps {
  /**
   * Pick the account for a new socket. Called once per upgrade, and again with
   * the first alias excluded when the upstream answers 401/403.
   *
   * Pinned to the pool's primary rather than routed, and that is not laziness.
   * The upgrade carries none of the signals extractSessionAffinitySignals reads
   * — no x-claude-code-session-id, no session-id, no body — so `stickyKey` is
   * structurally null and affinity cannot work here. Rather than let
   * `pool.select(null)` scatter voice sockets across seats that have nothing to
   * do with the session doing the talking, pin and say so.
   */
  selectAccount: (excluded: Set<string>) => VoiceAccount | null;
  /** Upstream origin. Injectable so the suite can point at a local fake. */
  upstream: { host: string; port: number; tls: boolean };
  /** True when --egress-proxy is configured; the relay declines rather than bypassing it. */
  egressProxyConfigured?: boolean;
  /**
   * An HTTP proxy that speaks CONNECT, used to carry the voice socket when an
   * egress proxy is configured. For a SOCKS egress this is socks5-bridge.ts's
   * own `proxyUrl` — the bridge exists precisely because Bun's fetch cannot
   * speak SOCKS either, and a CONNECT tunnel is the shape both need. For an
   * http/https egress it is that proxy directly, which speaks CONNECT natively.
   *
   * Without this the relay has no way to honour the egress proxy: it dials with
   * node:https, and installOutboundProxyWrapper only wraps globalThis.fetch. It
   * declines rather than bypassing, because a voice socket leaving by the
   * default route while every other upstream call went through the proxy is the
   * one failure the operator explicitly configured against.
   */
  egressConnectProxyUrl?: string;
  /** Whether the caller cleared dario's inbound auth. */
  authorize: (req: IncomingMessage) => boolean;
  log?: (message: string) => void;
  verbose?: boolean;
}

/** Handle returned by attachVoiceRelay so shutdown can reach detached sockets. */
export interface VoiceRelay {
  /** Live relay sockets. `server.close()` does not reach these. */
  readonly sockets: ReadonlySet<Duplex>;
  /** Destroy every live relay socket. Called from the proxy's close(). */
  destroyAll: () => void;
}

/** Path match, query string excluded. Exported for tests. */
export function isVoiceUpgradePath(url: string | undefined): boolean {
  if (!url) return false;
  // Compare the path only, and compare it literally. No normalization, no
  // decoding: `%2e%2e` and `/..%2f` never become a traversal because nothing
  // here ever resolves a segment.
  return url.split('?')[0] === VOICE_WS_PATH;
}

/**
 * Build the header bag for the upstream upgrade: the allowlist, verbatim, plus
 * a pool `Authorization` and a `host` for the upstream origin.
 *
 * Exported for tests — the assertion that matters is that a client-supplied
 * `authorization` is replaced rather than forwarded.
 */
export function buildUpstreamHeaders(
  incoming: IncomingMessage['headers'],
  accessToken: string,
  hostHeader: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of FORWARDED_UPGRADE_HEADERS) {
    const value = incoming[name];
    if (typeof value === 'string') out[name] = value;
  }
  out.host = hostHeader;
  out.authorization = `Bearer ${accessToken}`;
  return out;
}

/** Refuse an upgrade with a bare status line. There is no ServerResponse here. */
function refuse(socket: Duplex, status: number, reason: string, detail: string): void {
  if (!socket.destroyed) {
    socket.end(
      `HTTP/1.1 ${status} ${reason}\r\n`
      + 'Connection: close\r\n'
      + 'Content-Type: text/plain\r\n'
      + `Content-Length: ${Buffer.byteLength(detail)}\r\n\r\n`
      + detail,
    );
  }
}

/** Re-emit an upstream response CC will read through `ws`'s unexpected-response. */
function relayRefusal(socket: Duplex, status: number, message: string, headers: string[]): void {
  if (socket.destroyed) return;
  let head = `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n`;
  // request-id and retry-after are what CC quotes and what its retry logic
  // reads; the rest of the upstream's headers are none of the client's
  // business on a failed handshake.
  for (let i = 0; i < headers.length; i += 2) {
    const key = headers[i].toLowerCase();
    if (key === 'request-id' || key === 'retry-after') head += `${headers[i]}: ${headers[i + 1]}\r\n`;
  }
  socket.end(`${head}\r\n`);
}

/**
 * Attach the voice relay to dario's existing http server.
 *
 * Registered on the SAME server as the request handler. A request carrying
 * `Upgrade:`/`Connection: Upgrade` is routed to this event by both Bun and Node
 * and never reaches the request handler — measured on Bun 1.4.0 and Node
 * 22.23.1 — so the allowlist's 404 for a non-allowlisted path never fires for a
 * voice upgrade. A non-upgrade GET to the same path is a plain request and does
 * still get that 404, which is correct: without the upgrade there is nothing to
 * relay.
 */

/**
 * Open a CONNECT tunnel through `proxyUrl` to `host:port` and hand back the
 * tunnelled socket.
 *
 * Deliberately hand-rolled rather than routed through an agent library: this is
 * one CONNECT, once per voice socket, and the relay's whole design is to touch
 * as little of the byte stream as possible. Any leftover the proxy sends in the
 * same packet as its 200 is returned alongside the socket — dropping it would
 * eat the first bytes of the TLS handshake, which is the same trap
 * socks5-bridge.ts documents and the 101 path below hits again.
 */
function connectThroughProxy(
  proxyUrl: string,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<{ socket: Socket; head: Buffer }> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try { url = new URL(proxyUrl); } catch { reject(new Error(`unparseable egress proxy URL`)); return; }
    const socket = netConnect({
      host: url.hostname,
      port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
    });
    let settled = false;
    const done = (err: Error | null, head?: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      if (err) { socket.destroy(); reject(err); } else resolve({ socket, head: head ?? Buffer.alloc(0) });
    };
    const timer = setTimeout(() => done(new Error(`egress proxy did not answer CONNECT within ${timeoutMs / 1000}s`)), timeoutMs);
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) {
        // A proxy that never sends a complete header line is handled by `timer`.
        if (buf.length > 64 * 1024) done(new Error('egress proxy sent an oversized CONNECT response'));
        return;
      }
      const statusLine = buf.slice(0, buf.indexOf('\r\n')).toString('latin1');
      const code = Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1]);
      if (code !== 200) { done(new Error(`egress proxy refused CONNECT: ${statusLine.trim() || 'no status line'}`)); return; }
      done(null, buf.slice(end + 4));
    };
    socket.on('data', onData);
    socket.once('error', (e) => done(e));
    socket.once('close', () => done(new Error('egress proxy closed the connection during CONNECT')));
    socket.once('connect', () => {
      const auth = url.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}\r\n`
        : '';
      const target = `${host}:${port}`;
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
    });
  });
}

export function attachVoiceRelay(server: Server, deps: VoiceRelayDeps): VoiceRelay {
  const log = deps.log ?? ((m: string) => console.log(m));
  const sockets = new Set<Duplex>();

  server.on('upgrade', (req: IncomingMessage, clientSocket: Duplex, clientHead: Buffer) => {
    // Attach before anything can fail. The server hands the socket over bare —
    // its own 'error' handler is gone by the time this fires — and an unhandled
    // 'error' on a bare socket is an uncaught exception. Post-bind, proxy.ts
    // turns a server 'error' into process.exit(1), so a client that aborts
    // during the upstream dial would otherwise take dario down.
    let upstreamSocket: Duplex | null = null;
    let settled = false;
    const teardown = (): void => {
      sockets.delete(clientSocket);
      upstreamSocket?.destroy();
      clientSocket.destroy();
    };
    clientSocket.on('error', teardown);
    clientSocket.on('close', teardown);
    sockets.add(clientSocket);

    if (!isVoiceUpgradePath(req.url)) {
      // Same verdict the HTTP allowlist gives an unknown path, so a client
      // cannot learn which paths exist by switching transports.
      if (deps.verbose) log(`[dario] voice: upgrade path not in the allowlist, answering 404: ${req.url}`);
      refuse(clientSocket, 404, 'Not Found', 'Not found\n');
      return;
    }

    if (!deps.authorize(req)) {
      // CC cannot help here: it sends `Authorization: Bearer <its own OAuth
      // token>` on this socket, hardcoded, so it can never present dario's key.
      // The gate that actually applies is loopback — see proxy.ts.
      refuse(clientSocket, 401, 'Unauthorized', 'Voice relay requires a loopback client or a valid dario key\n');
      return;
    }

    if (deps.egressProxyConfigured && !deps.egressConnectProxyUrl) {
      refuse(clientSocket, 502, 'Bad Gateway',
        'dario declines voice relaying while --egress-proxy is set and no CONNECT tunnel is available:\n'
        + 'the relay dials with node:https, which the egress wrapper (globalThis.fetch only) does not\n'
        + 'cover. Relaying anyway would send this socket direct while every other upstream call\n'
        + 'honoured the proxy.\n');
      log('[dario] voice: declined an upgrade — --egress-proxy is set and the relay cannot honour it');
      return;
    }

    const tried = new Set<string>();

    const dial = (tunnel?: { socket: Socket; head: Buffer }): void => {
      const account = deps.selectAccount(tried);
      if (!account) {
        tunnel?.socket.destroy();
        refuse(clientSocket, 503, 'Service Unavailable', 'No account available to carry the voice stream\n');
        return;
      }
      tried.add(account.alias);

      const hostHeader = deps.upstream.port === (deps.upstream.tls ? 443 : 80)
        ? deps.upstream.host
        : `${deps.upstream.host}:${deps.upstream.port}`;
      const options: RequestOptions & { createConnection?: () => Socket } = {
        host: deps.upstream.host,
        port: deps.upstream.port,
        path: req.url,                    // query string byte-identical, order intact
        method: 'GET',
        headers: buildUpstreamHeaders(req.headers, account.accessToken, hostHeader),
      };
      if (tunnel) {
        // Hand node:https a socket that is already on the far side of the
        // egress proxy. TLS is negotiated over the tunnel with the upstream's
        // real hostname, so certificate validation and SNI are unaffected by
        // the hop — the proxy saw a CONNECT and nothing else.
        // TLS over the tunnel when the origin is https, with the origin's own
        // hostname for SNI and certificate validation — the proxy saw a CONNECT
        // and nothing more. A plaintext origin (the suite's fake) rides the
        // tunnel bare; wrapping it would negotiate TLS against a server that
        // does not speak it.
        options.createConnection = () => (deps.upstream.tls
          ? tlsConnect({ socket: tunnel.socket, servername: deps.upstream.host })
          : tunnel.socket) as unknown as Socket;
      }
      const upstreamReq = deps.upstream.tls ? httpsRequest(options) : httpRequest(options);

      const timer = setTimeout(() => {
        upstreamReq.destroy(new Error(`upstream did not answer within ${CONNECT_TIMEOUT_MS / 1000}s`));
      }, CONNECT_TIMEOUT_MS);
      const clearTimer = (): void => { clearTimeout(timer); };

      upstreamReq.on('upgrade', (upstreamRes, socket: Duplex, upstreamHead: Buffer) => {
        clearTimer();
        settled = true;
        upstreamSocket = socket;
        socket.on('error', teardown);
        socket.on('close', teardown);
        if (clientSocket.destroyed) { socket.destroy(); return; }

        // Replay the 101 with the upstream's own header casing and order. The
        // client is about to check Sec-WebSocket-Accept against the key it
        // sent, and it sent that key through us unchanged, so this verifies.
        let head = `HTTP/1.1 ${upstreamRes.statusCode ?? 101} ${upstreamRes.statusMessage ?? 'Switching Protocols'}\r\n`;
        for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
          head += `${upstreamRes.rawHeaders[i]}: ${upstreamRes.rawHeaders[i + 1]}\r\n`;
        }
        clientSocket.write(`${head}\r\n`);

        // Both head buffers, unconditionally, before either pipe is wired.
        // This is the one portability trap in the whole module: on Bun the
        // bytes an upstream sends in the same packet as its 101 arrive in
        // `upstreamHead`, and on Node they arrive later as 'data' with
        // `upstreamHead` empty (measured on Bun 1.4.0 / Node 22.23.1). Ignore
        // it and Bun silently eats the server's first frame. Same shape as
        // socks5-bridge.ts writing its CONNECT leftover.
        if (upstreamHead?.length) clientSocket.write(upstreamHead);
        if (clientHead?.length) socket.write(clientHead);

        // pipeline(), not pipe(): it reports completion as well as error and
        // flushes the destination. pipe() plus allowHalfOpen leaked one
        // upstream socket per tunnel in socks5-bridge.ts whenever the origin
        // closed first, and a dictation socket has no use for half-open.
        pipeline(socket, clientSocket, teardown);
        pipeline(clientSocket, socket, teardown);

        const startedAt = Date.now();
        socket.once('close', () => {
          log(`[dario] voice ws → ${account.alias} closed after ${Math.round((Date.now() - startedAt) / 1000)}s`);
        });
        log(`[dario] voice ws → ${account.alias} (upgraded)`);
      });

      upstreamReq.on('response', (upstreamRes) => {
        clearTimer();
        upstreamRes.resume();
        const status = upstreamRes.statusCode ?? 502;
        // A stale pool token shows up here, and CC treats any 4xx on this
        // socket as fatal (`fatal: k >= 400 && k < 500` in its
        // unexpected-response handler) — the user gets no retry at all. So do
        // the failover proxy.ts does for HTTP rather than relaying the 401
        // down and calling it the user's problem. Once only: a second 401 is
        // a real credential problem, not a stale seat.
        if ((status === 401 || status === 403) && !settled && tried.size === 1) {
          log(`[dario] voice: ${status} on ${account.alias}, trying the next account`);
          // A fresh tunnel: the first one is spent, and its TLS session is
          // bound to the request that just failed.
          void startDial();
          return;
        }
        settled = true;
        if (deps.verbose) log(`[dario] voice: upstream refused the upgrade with ${status}`);
        relayRefusal(clientSocket, status, upstreamRes.statusMessage ?? '', upstreamRes.rawHeaders);
      });

      upstreamReq.on('error', (err: Error) => {
        clearTimer();
        if (settled) return;
        settled = true;
        if (deps.verbose) log(`[dario] voice: upstream dial failed: ${err.message}`);
        refuse(clientSocket, 502, 'Bad Gateway', `Failed to reach the voice endpoint: ${err.message}\n`);
      });

      upstreamReq.end();
    };

    /**
     * Open the egress tunnel if one is configured, then dial. Split from
     * `dial` so the 401 failover can take a fresh tunnel rather than reusing a
     * spent one, and so a tunnel failure refuses the upgrade with the reason
     * instead of surfacing as a bare socket error.
     */
    const startDial = async (): Promise<void> => {
      if (!deps.egressConnectProxyUrl) { dial(); return; }
      try {
        const tunnel = await connectThroughProxy(
          deps.egressConnectProxyUrl, deps.upstream.host, deps.upstream.port, CONNECT_TIMEOUT_MS);
        if (clientSocket.destroyed) { tunnel.socket.destroy(); return; }
        if (tunnel.head.length) {
          // The proxy should send nothing after its 200 before we speak, and
          // every proxy measured does exactly that. If one ever does, those
          // bytes are the start of the TLS handshake and there is no way to
          // push them back into the socket ahead of tlsConnect — so refuse
          // loudly rather than negotiate TLS against a truncated stream.
          tunnel.socket.destroy();
          refuse(clientSocket, 502, 'Bad Gateway',
            'The egress proxy sent data immediately after CONNECT; refusing to relay a voice socket\n'
            + 'whose TLS handshake would start mid-stream.\n');
          return;
        }
        dial(tunnel);
      } catch (err) {
        if (clientSocket.destroyed) return;
        if (deps.verbose) log(`[dario] voice: egress tunnel failed: ${(err as Error).message}`);
        refuse(clientSocket, 502, 'Bad Gateway',
          `Failed to open an egress tunnel for the voice socket: ${(err as Error).message}\n`);
      }
    };

    void startDial();
  });

  return {
    sockets,
    destroyAll: () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
  };
}
