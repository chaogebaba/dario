// SOCKS5 → local HTTP-CONNECT bridge.
//
// Bun's fetch speaks the `proxy` option, but only for http:/https: proxy
// URLs — a socks5: URL throws `UnsupportedProxyProtocol`. Rewriting the
// upstream hot path onto node:http + a SOCKS agent would work, but it
// would also move TLS off Bun's BoringSSL stack and change the JA3
// fingerprint that dario exists to preserve (docs/wire-fidelity.md).
//
// So instead of teaching fetch to speak SOCKS, we put a shim in front of
// it: a loopback HTTP proxy that accepts CONNECT from Bun's fetch, dials
// the real SOCKS5 proxy, performs the handshake, and then pipes bytes.
// Bun still originates the TLS ClientHello and terminates TLS at
// api.anthropic.com; the bridge only moves already-encrypted bytes.
//
//   Bun fetch --CONNECT--> 127.0.0.1:ephemeral --SOCKS5--> proxy --> origin
//   |<-------------------------- TLS session -------------------------->|
//
// The bridge binds 127.0.0.1 on an ephemeral port and is never exposed
// off-host, but loopback is not the same as private: without a
// credential any other local process or user could relay through the
// operator's SOCKS5 proxy. So it mints a per-process token and answers
// 407 without it. SOCKS5 username and password (RFC 1929) are held in
// memory and written only to the proxy socket during the handshake.
//
// socks5h resolves the destination hostname at the proxy (no local DNS
// leak) and is the right default for egress routing. socks5 resolves
// locally and sends an address, which leaks the lookup to the local
// resolver — supported because curl draws the same distinction.

import { createServer as createHttpServer, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { lookup } from 'node:dns/promises';
import { pipeline, type Duplex } from 'node:stream';

/** SOCKS5 reply codes (RFC 1928 §6), mapped to operator-legible text. */
const REPLY_TEXT: Record<number, string> = {
  0x01: 'general SOCKS server failure',
  0x02: 'connection not allowed by ruleset',
  0x03: 'network unreachable',
  0x04: 'host unreachable',
  0x05: 'connection refused',
  0x06: 'TTL expired',
  0x07: 'command not supported',
  0x08: 'address type not supported',
};

export interface Socks5BridgeOptions {
  /** SOCKS5 proxy host. */
  host: string;
  /** SOCKS5 proxy port. */
  port: number;
  /** RFC 1929 username, if the proxy requires auth. */
  username?: string;
  /** RFC 1929 password. */
  password?: string;
  /** socks5h → resolve the destination at the proxy. socks5 → resolve locally. */
  remoteDns: boolean;
  /** Bound on the SOCKS dial + handshake. Default 30s. */
  timeoutMs?: number;
}

export interface Socks5Bridge {
  /** Loopback port the bridge is listening on. */
  port: number;
  /** `http://127.0.0.1:<port>` — safe to log, carries no token. */
  url: string;
  /**
   * `http://dario:<token>@127.0.0.1:<port>` — what fetch's `proxy` option
   * gets. Never log this.
   */
  proxyUrl: string;
  /** Stop accepting, drop live tunnels, and close the listener. */
  close(): Promise<void>;
}

/**
 * Reads an exact number of bytes off a socket, buffering short reads.
 * A SOCKS handshake is a sequence of fixed-width frames, and TCP is free
 * to deliver them in any chunking it likes — reading `data` events
 * directly is the classic way to get a bridge that works on localhost
 * and fails against a real proxy.
 */
class ByteReader {
  private buf: Buffer = Buffer.alloc(0);
  private want: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  private failure: Error | null = null;
  private readonly sock: Socket;

  private readonly onData = (d: Buffer): void => {
    this.buf = this.buf.length === 0 ? d : Buffer.concat([this.buf, d]);
    this.pump();
  };
  private readonly onError = (e: Error): void => this.fail(e);
  private readonly onClose = (): void =>
    this.fail(new Error('SOCKS5 proxy closed the connection during the handshake'));

  constructor(sock: Socket) {
    this.sock = sock;
    sock.on('data', this.onData);
    sock.on('error', this.onError);
    sock.on('close', this.onClose);
  }

  private pump(): void {
    if (!this.want || this.buf.length < this.want.n) return;
    const { n, resolve } = this.want;
    this.want = null;
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    resolve(out);
  }

  private fail(e: Error): void {
    if (this.failure) return;
    this.failure = e;
    const w = this.want;
    this.want = null;
    if (w) w.reject(e);
  }

  read(n: number): Promise<Buffer> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<Buffer>((resolve, reject) => {
      this.want = { n, resolve, reject };
      this.pump();
    });
  }

  /**
   * Hand the socket back for tunnelling and return whatever arrived past
   * the handshake, so the caller can replay it into the tunnel.
   *
   * Detaching is not housekeeping — it is load-bearing. A reader left
   * attached keeps appending every tunnelled byte to `buf`, so a streamed
   * response is retained in full *and* re-copied on each chunk: 24 MiB
   * through the tunnel cost 137 MiB of RSS before this existed. Pausing
   * matters too: with the last `data` listener gone the socket is still
   * in flowing mode, and anything read before `pipe()` resumes it would
   * be emitted to nobody and lost.
   */
  detach(): Buffer {
    this.sock.off('data', this.onData);
    this.sock.off('error', this.onError);
    this.sock.off('close', this.onClose);
    this.sock.pause();
    const rest = this.buf;
    this.buf = Buffer.alloc(0);
    return rest;
  }
}

/** Encode the SOCKS5 CONNECT address field for a destination. */
async function encodeTarget(host: string, remoteDns: boolean): Promise<Buffer> {
  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    return Buffer.concat([Buffer.from([0x01]), Buffer.from(host.split('.').map(Number))]);
  }
  if (ipVersion === 6) {
    const groups = expandIpv6(host);
    return Buffer.concat([Buffer.from([0x04]), groups]);
  }
  if (remoteDns) {
    const name = Buffer.from(host, 'ascii');
    if (name.length > 255) throw new Error(`destination hostname is too long for SOCKS5 (${name.length} > 255 bytes)`);
    return Buffer.concat([Buffer.from([0x03, name.length]), name]);
  }
  // socks5 (no trailing h): resolve here and send an address literal.
  const { address, family } = await lookup(host);
  if (family === 4) {
    return Buffer.concat([Buffer.from([0x01]), Buffer.from(address.split('.').map(Number))]);
  }
  return Buffer.concat([Buffer.from([0x04]), expandIpv6(address)]);
}

/** Expand an IPv6 literal (possibly `::`-compressed) to 16 raw bytes. */
function expandIpv6(addr: string): Buffer {
  const stripped = addr.replace(/^\[|\]$/g, '').split('%')[0];
  const [head, tail] = stripped.split('::');
  const headParts = head ? head.split(':').filter(Boolean) : [];
  const tailParts = tail ? tail.split(':').filter(Boolean) : [];
  const fill = 8 - headParts.length - tailParts.length;
  const parts = [...headParts, ...Array(stripped.includes('::') ? fill : 0).fill('0'), ...tailParts];
  const out = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    out.writeUInt16BE(parseInt(parts[i] || '0', 16) & 0xffff, i * 2);
  }
  return out;
}

/**
 * Dial the SOCKS5 proxy and negotiate a tunnel to `destHost:destPort`.
 * Resolves with a socket positioned at the first byte of tunnelled data.
 */
async function socks5Connect(
  opts: Socks5BridgeOptions,
  destHost: string,
  destPort: number,
): Promise<{ socket: Socket; leftover: Buffer }> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const sock = netConnect({ host: opts.host, port: opts.port });
  sock.setNoDelay(true);

  const reader = new ByteReader(sock);

  // Destroying the socket on timeout beats racing a rejection against the
  // handshake: the loser of a Promise.race never settles, so a rejecting
  // guard would leak one pending promise per tunnel. Tearing down the
  // socket makes the handshake reject on its own; `expired` just supplies
  // the better message.
  let expired: Error | null = null;
  const timer = setTimeout(() => {
    expired = new Error(`SOCKS5 handshake to ${opts.host}:${opts.port} timed out after ${timeoutMs}ms`);
    sock.destroy();
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  const handshake = (async () => {
    await new Promise<void>((resolve, reject) => {
      const onConnect = (): void => { sock.off('error', onError); resolve(); };
      const onError = (e: Error): void => { sock.off('connect', onConnect); reject(e); };
      sock.once('connect', onConnect);
      sock.once('error', onError);
    });

    // ── Greeting ───────────────────────────────────────────────
    const useAuth = Boolean(opts.username);
    const methods = useAuth ? [0x00, 0x02] : [0x00];
    sock.write(Buffer.from([0x05, methods.length, ...methods]));

    const greeting = await reader.read(2);
    if (greeting[0] !== 0x05) {
      throw new Error(`SOCKS5 proxy replied with protocol version ${greeting[0]}, expected 5`);
    }
    const method = greeting[1];
    if (method === 0xff) {
      throw new Error(
        useAuth
          ? 'SOCKS5 proxy rejected both no-auth and username/password authentication'
          : 'SOCKS5 proxy requires authentication — add credentials to the proxy URL (socks5h://user:pass@host:port)',
      );
    }

    // ── Username/password auth (RFC 1929) ──────────────────────
    if (method === 0x02) {
      if (!useAuth) throw new Error('SOCKS5 proxy demanded username/password auth but no credentials were configured');
      const u = Buffer.from(opts.username ?? '', 'utf8');
      const p = Buffer.from(opts.password ?? '', 'utf8');
      if (u.length > 255 || p.length > 255) throw new Error('SOCKS5 username/password must each be 255 bytes or fewer');
      sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
      const authReply = await reader.read(2);
      if (authReply[1] !== 0x00) {
        throw new Error('SOCKS5 proxy rejected the supplied username/password');
      }
    } else if (method !== 0x00) {
      throw new Error(`SOCKS5 proxy selected unsupported auth method 0x${method.toString(16)}`);
    }

    // ── CONNECT ────────────────────────────────────────────────
    const target = await encodeTarget(destHost, opts.remoteDns);
    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(destPort, 0);
    sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), target, portBuf]));

    const reply = await reader.read(4);
    if (reply[0] !== 0x05) throw new Error(`SOCKS5 reply had version ${reply[0]}, expected 5`);
    if (reply[1] !== 0x00) {
      const why = REPLY_TEXT[reply[1]] ?? `unknown failure 0x${reply[1].toString(16)}`;
      throw new Error(`SOCKS5 proxy refused CONNECT to ${destHost}:${destPort} — ${why}`);
    }
    // Drain the bound-address field so the tunnel starts clean.
    const atyp = reply[3];
    if (atyp === 0x01) await reader.read(4 + 2);
    else if (atyp === 0x04) await reader.read(16 + 2);
    else if (atyp === 0x03) {
      const len = await reader.read(1);
      await reader.read(len[0] + 2);
    } else {
      throw new Error(`SOCKS5 reply used unsupported address type 0x${atyp.toString(16)}`);
    }

    return { socket: sock, leftover: reader.detach() };
  })();

  try {
    return await handshake;
  } catch (err) {
    sock.destroy();
    throw expired ?? err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Start the loopback bridge. Resolves once it is accepting connections.
 *
 * Failures during a tunnel are reported to the client as a CONNECT error
 * response, not thrown — a single bad upstream must not take the proxy
 * down. Messages never include credentials.
 */
export function startSocks5Bridge(opts: Socks5BridgeOptions): Promise<Socks5Bridge> {
  // Loopback-only is not the same as private. Without a credential, every
  // other process and every other user on the box could tunnel through
  // the operator's SOCKS5 proxy — metered, paid, and identity-bearing.
  // Bun's fetch sends Proxy-Authorization for userinfo in the proxy URL
  // (verified), so a per-process token costs nothing and closes it.
  const token = randomBytes(24).toString('base64url');
  const expected = Buffer.from(`Basic ${Buffer.from(`dario:${token}`).toString('base64')}`);
  const authorized = (header: string | undefined): boolean => {
    if (!header) return false;
    const got = Buffer.from(header);
    // Length differs → not ours, and timingSafeEqual would throw.
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  // Bun's fetch only issues CONNECT for https: targets. dario's upstreams
  // are all https:, so an absolute-form request here means something is
  // misconfigured — answer 501 rather than silently mishandling it.
  const server: Server = createHttpServer((_req, res) => {
    res.writeHead(501, { 'content-type': 'text/plain' });
    res.end('dario SOCKS5 bridge accepts CONNECT only (upstream traffic is HTTPS).\n');
  });

  // CONNECT sockets are detached from the http server, so nothing else
  // tracks them: `server.close()` would return while tunnels stayed open,
  // and closeAllConnections() does not reach them either.
  const tunnels = new Set<Duplex>();

  server.on('connect', (req, clientSocket: Duplex, head: Buffer) => {
    let upstream: Socket | null = null;
    const teardown = (): void => {
      tunnels.delete(clientSocket);
      upstream?.destroy();
      clientSocket.destroy();
    };
    // Attach before anything can fail. Node hands the socket over bare —
    // its own 'error' handler is removed when this event fires — and an
    // unhandled 'error' on a bare socket is an uncaught exception. A
    // client that aborts while the SOCKS handshake is still in flight
    // would otherwise take the whole proxy down.
    //
    // 'close' (not 'end') drives teardown, so a half-close still gets
    // forwarded by pipe's end:true. This has to be explicit now that the
    // reader detaches and pauses: a paused socket never reads the peer's
    // FIN, so allowHalfOpen=false can no longer auto-close it. The
    // explicit version is also the correct one — if the client walks away
    // while the origin is still streaming, nothing else would ever close
    // the SOCKS half.
    clientSocket.on('error', teardown);
    clientSocket.on('close', teardown);
    tunnels.add(clientSocket);

    if (!authorized(req.headers['proxy-authorization'])) {
      clientSocket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\n' +
        'Proxy-Authenticate: Basic realm="dario"\r\n\r\n',
      );
      return;
    }

    const raw = req.url ?? '';
    const idx = raw.lastIndexOf(':');
    const destHost = idx > 0 ? raw.slice(0, idx).replace(/^\[|\]$/g, '') : '';
    const destPort = idx > 0 ? Number(raw.slice(idx + 1)) : NaN;

    if (!destHost || !Number.isInteger(destPort) || destPort < 1 || destPort > 65535) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }

    socks5Connect(opts, destHost, destPort).then(
      ({ socket: sock, leftover }) => {
        upstream = sock;
        if (clientSocket.destroyed) {
          sock.destroy();
          return;
        }
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (leftover.length) clientSocket.write(leftover);
        if (head?.length) sock.write(head);

        // pipeline(), not pipe(): it reports completion as well as error,
        // and flushes the destination before calling back. Relying on
        // pipe() plus allowHalfOpen left the socket pair alive whenever
        // the *origin* closed first — the response finished, both halves
        // stayed open, and one SOCKS connection leaked per request.
        // Either direction finishing ends the tunnel; a CONNECT tunnel
        // has no use for half-open once one side is done.
        pipeline(sock, clientSocket, teardown);
        pipeline(clientSocket, sock, teardown);
      },
      (err: Error) => {
        if (!clientSocket.destroyed) {
          clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n${err.message}\n`);
        }
      },
    );
  });

  return new Promise<Socks5Bridge>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('SOCKS5 bridge failed to bind a loopback port'));
        return;
      }
      // Don't hold the event loop open on our account; the inbound proxy
      // server is what keeps dario alive.
      server.unref();
      resolve({
        port: addr.port,
        url: `http://127.0.0.1:${addr.port}`,
        proxyUrl: `http://dario:${token}@127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((done) => {
          for (const t of tunnels) t.destroy();
          tunnels.clear();
          server.close(() => done());
        }),
      });
    });
  });
}
