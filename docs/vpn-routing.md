# VPN routing

For users who want their dario traffic — `api.anthropic.com` requests, OAuth flows, OpenAI-compat backend forwarding — routed through a VPN without putting the entire host on a system VPN. Three approaches, ordered by friction:

## Option A — System VPN (zero config, covers everyone)

The simplest approach. Run a system-level VPN client and **all** outbound from your machine — including dario's calls — goes through the tunnel.

```bash
# 1. Install your provider's client (ProtonVPN, Mullvad, AirVPN, Tailscale, raw WireGuard…)
# 2. Connect.
# 3. Verify your egress IP changed:
curl ifconfig.me
# 4. Run dario normally:
dario proxy
```

This covers every dario use case. No flags needed. The tradeoff is that *all* traffic from the machine is now tunneled — fine if you wanted that anyway, less ideal if you only want dario egress to be private.

## Option B — Per-process via `--egress-proxy=` (v3.35.0+, SOCKS5 in v5.6)

Routes only dario's outbound through a proxy. The rest of your system stays on the default route.

```bash
# Mullvad's HTTP proxy endpoint
dario proxy --egress-proxy=http://10.64.0.1:80

# SOCKS5 with the destination resolved at the proxy (no local DNS leak)
dario proxy --egress-proxy=socks5h://127.0.0.1:1080

# Or with credentials embedded:
dario proxy --egress-proxy=socks5h://user:pass@proxy.example.com:1080

# Or via env var:
DARIO_EGRESS_PROXY=http://127.0.0.1:8118 dario proxy

# Older spellings still work:
dario proxy --via=http://127.0.0.1:8118
DARIO_UPSTREAM_PROXY=http://127.0.0.1:8118 dario proxy
```

Set it once in `~/.dario/config.json` (or the TUI's Config tab, `Egress proxy` row) to avoid passing it every time:

```json
{ "egressProxy": "socks5h://127.0.0.1:1080" }
```

Precedence is the usual chain: `--egress-proxy` > `DARIO_EGRESS_PROXY` > `DARIO_UPSTREAM_PROXY` > config file. Within the command line the last occurrence wins, whichever spelling it uses, so an appended override beats what a wrapper script already passed. An explicitly empty value (`--egress-proxy=`) routes direct, overriding a lower layer.

The config file holds the URL verbatim, credentials included. `~/.dario/config.json` is written 0600 inside a 0700 directory, and neither `dario config`, `dario doctor`, nor the TUI ever renders the password — but it is on disk in cleartext, which matters for backups and for anything that syncs a home directory.

### socks5h vs socks5

`socks5h://` resolves the destination hostname **at the proxy**. `socks5://` resolves it **locally** and sends an address literal, which leaks the lookup to your local resolver even though the connection itself is tunneled. Prefer `socks5h://` unless you specifically need local resolution. This is the same distinction curl draws between `--socks5-hostname` and `--socks5`.

SOCKS4/4a are rejected: no authentication, no IPv6, no remote DNS.

### How SOCKS5 is implemented

Bun's `fetch` only understands `http:`/`https:` proxy URLs. Rather than move the upstream request onto Node's HTTP stack — which would change the TLS ClientHello dario exists to preserve — dario starts an in-process CONNECT bridge on loopback and points fetch at that:

```
Bun fetch --CONNECT--> 127.0.0.1:ephemeral --SOCKS5--> proxy --> origin
|<--------------------------- TLS session --------------------------->|
```

The bridge only moves already-encrypted bytes. TLS still originates in Bun and terminates at the origin, so the fingerprint is unchanged. The listener binds `127.0.0.1` on an ephemeral port and is never exposed off-host.

Loopback is not the same as private, though. Without a credential, any other process — or any other user — on the machine could tunnel through your SOCKS5 proxy, which is metered, paid, and identity-bearing. So the bridge mints a random token per dario process and answers `407` to a CONNECT that doesn't carry it; Bun's `fetch` sends it as Basic auth from the userinfo in the proxy URL. The token exists only in memory and is never logged — the startup banner prints the bare `http://127.0.0.1:<port>`.

dario's startup banner confirms when it's active:

```
[dario] SOCKS5 bridge listening on http://127.0.0.1:38471 (loopback only)
[dario] Egress proxy: socks5h://127.0.0.1:1080 (all upstream fetches routed; localhost bypasses, DNS resolved at proxy)
[dario] Egress IP: 185.244.213.7 — this is the address Anthropic sees (101ms)
```

### The egress check, and why it's fatal

That last line is the only one that proves anything. A URL that parses, a bridge that binds, a SOCKS5 handshake that completes — all of it is equally consistent with a proxy that accepts your connection and then forwards from this host's own address. Nothing dario can observe from inside the process distinguishes the two. So it asks a remote endpoint and reports what came back.

Asking once isn't enough either. An endpoint that answers proves the proxy carries traffic, not that it changed where the traffic comes from. So dario asks twice at startup — once through the proxy, once over the default route with the pre-wrap fetch — and compares. Same address both ways means the proxy is forwarding from this host rather than replacing its address, which is what a split-tunnel rule, a transparent proxy, or an upstream that was never configured all look like:

```
[dario] Egress check: the proxy is reachable, but traffic still leaves from 203.0.113.7.
[dario] That is the same address as an unproxied request, so the proxy is forwarding
[dario] from this host rather than replacing its address.
```

That baseline request goes out the default route on purpose — it is the control. Anyone running a proxy precisely so that never happens can drop it with `DARIO_SKIP_EGRESS_BASELINE=1`, which gives up the comparison and keeps the reachability check. A baseline that *fails* is not treated as a problem: an endpoint unreachable without the proxy is itself evidence traffic isn't taking the default route, so only a successful baseline can convict.

If the check fails outright, `dario proxy` **refuses to start**:

```
[dario] Egress check failed: could not reach https://cloudflare.com/cdn-cgi/trace — ECONNREFUSED
[dario] Refusing to start: the egress proxy is configured but not usable, and running
[dario] without it would send your traffic out the address the proxy exists to replace.
```

It never falls back to direct. The failure being guarded against is subscription traffic silently leaving from your home IP, and that one can't be undone once it's happened. Three ways forward: fix the proxy, clear the setting (`--egress-proxy=`, or empty the Config tab row), or `--skip-egress-check` to start anyway and let individual requests fail.

The endpoint defaults to Cloudflare's `cdn-cgi/trace` — plain text, no key, and already in the path for much of the internet, so asking it reveals nothing it couldn't already see. Point `DARIO_EGRESS_IP_URL` (or config `egressIpUrl`) somewhere else if you'd rather not. The parser takes Cloudflare's `key=value` form, a bare address, or JSON carrying `ip` / `origin` / `address`; anything that isn't a valid IP counts as a failed check, so a captive portal's login page reads as broken rather than as an answer.

The TUI's Status tab carries the same information live, under **Egress** — the route, the address, and how long ago it was checked, going red when the check starts failing. It's re-probed in the background at most once every 5 minutes, so a `/health` poller never pays for it. The row is gated to trusted callers: a `/health` exposed publicly through a Cloudflare tunnel returns liveness only and never your exit IP.

`dario doctor` surfaces the configuration side:

```
[INFO]  Outbound proxy   DARIO_UPSTREAM_PROXY=http://10.64.0.1:80/. Upstream fetches routed via this proxy; localhost calls bypass.
```

### Provider matrix

| Provider | HTTP proxy | Notes |
|---|---|---|
| **Mullvad** | `http://10.64.0.1:80` (default) | SOCKS5 also at `:1080`; use HTTP for dario |
| **AirVPN** | `http://nl.airvpn.org:443` (varies by region) | HTTP available on all gateways |
| **ProtonVPN** | (no native HTTP proxy) | Use Option A (system VPN) instead |
| **Privoxy / Polipo** | `http://127.0.0.1:8118` | Local; useful with Tor (`forward-socks5 / 127.0.0.1:9050`) |
| **Cloudflare WARP** | `http://127.0.0.1:40000` | Native HTTP proxy mode in `warp-cli set-mode proxy` |
| **Corporate proxy** | `http://proxy.corp:8080` | Standard org pattern |
| **Squid (self-hosted)** | `http://your-squid:3128` | Run a squid instance in a desired jurisdiction |

### Constraints

- **Bun runtime required.** Bun's fetch implements the `proxy` option natively. Node's built-in fetch ignores it silently — to avoid a false-success failure mode where the flag appears to work while requests actually go direct, dario refuses to start with `--egress-proxy` unless running under Bun.
- **SOCKS4/4a are rejected.** No authentication, no IPv6, no remote DNS. Use `socks5h://`. A `privoxy` bridge (`forward-socks5 / 127.0.0.1:1080`) still works if you prefer to terminate SOCKS outside dario, but it is no longer necessary.
- **TLS terminates end-to-end at Anthropic.** The proxy sees only the destination hostname (via SNI) and byte timing in CONNECT mode — not your request bodies. Your `bun-match` BoringSSL ClientHello is preserved.
- **Localhost calls bypass the proxy.** Anything dario fetches at `localhost`, `127.0.0.1`, `::1`, or any `*.localhost` host goes direct (so self-tests and inbound aren't accidentally tunneled).
- **Upstreams must be `https:` while a SOCKS proxy is set.** The bridge accepts CONNECT only, so an OpenAI-compat backend registered with an `http://` base-url (a LAN or self-hosted one) gets a 501 naming the setting rather than a tunneled cleartext request. Switch that backend to `https://`, or drop the egress proxy for that host. `--egress-proxy http://…` has no such restriction.

## Option C — Tailscale exit nodes (zero dario config, ideal for teams)

If you already run Tailscale, you can route through any peer node:

```bash
# 1. Designate an exit node on a peer (e.g., a Tailscale-routed node in a desired region)
# 2. From your machine:
sudo tailscale up --exit-node=<peer-name-or-IP>
# 3. Run dario normally — egress is now via the Tailscale exit
dario proxy
```

This is the cleanest pattern for teams: one peer runs in a known jurisdiction, every team member's dario egresses through it, audit trail lives at the peer. The hosted dario Pro tier can ship managed exit nodes as a turnkey feature.

## What this does NOT do

- **Doesn't change CC's wire fingerprint.** TLS ClientHello is still Bun's BoringSSL (or Node's OpenSSL if you're on Node — see `dario doctor`'s Runtime/TLS row). The proxy is at L4 transport; the L7 TLS fingerprint is end-to-end.
- **Doesn't hide your usage from Anthropic.** Anthropic still sees an authenticated OAuth subscription session billed against your account. Egress IP varies; the account does not.
- **Doesn't proxy CC's own traffic during live capture.** dario spawns the installed `claude` binary to capture its outbound — that subprocess uses the host's normal network. If you also want CC's capture traffic tunneled, run dario under Option A or C.

## Verifying it's working

The most direct check: hit a request-and-response endpoint that echoes your egress IP:

```bash
# With dario running:
DARIO_UPSTREAM_PROXY=http://your-proxy:port dario proxy --verbose &

# Then in another terminal, force a request through dario:
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-haiku-4-5","max_tokens":50,"messages":[{"role":"user","content":"hi"}]}'

# In the dario verbose log, the upstream connection will show as routed
# via the proxy. Provider-side logs (Mullvad / AirVPN / squid) will show
# a CONNECT to api.anthropic.com:443 from your dario process.
```

If your VPN provider's status page or dashboard shows the connection, the routing is working. If it doesn't, double-check that dario is running under Bun (`dario doctor`'s Runtime/TLS row should say `bun-match`).
