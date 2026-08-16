# Running dario as a systemd service

`dario proxy` is a long-running loopback server, so a user-scope systemd unit is the natural way to keep it up. `scripts/install-systemd.sh` writes the unit, enables it, and starts it.

```bash
scripts/install-systemd.sh
```

That builds the checkout if `dist/` is missing, writes `~/.config/systemd/user/dario.service`, runs `daemon-reload`, then `enable --now`. It waits for the service to settle and prints the recent journal if it failed to come up, rather than reporting success and leaving you to discover otherwise.

The unit is **user-scope, not system-scope**. dario reads the calling user's credentials from `~/.dario` and device identity from `~/.claude*`, and binds loopback. A system unit would run as root or a service account and see none of it. Nothing in the installer needs `sudo`.

## Prerequisites

- Linux with systemd and a live user manager (`XDG_RUNTIME_DIR` set — a plain `su` session does not have one).
- Bun ≥ 1.4.0 (the version `package.json` declares in `engines`). Bun is the runtime, not an optimisation — the TLS fingerprint and `fetch`'s proxy option both depend on it — so the installer refuses older builds.
- Credentials already set up (`dario login`). Without them the proxy starts and reports unhealthy, and the installer will tell you so.

## Day-to-day

```bash
systemctl --user status dario.service        # is it up
journalctl --user -u dario.service -f        # follow logs
systemctl --user restart dario.service       # apply a config change
curl -fsS http://127.0.0.1:3456/health       # 200 healthy, 503 degraded
```

## Configuration

Configuration lives in `~/.dario/config.json` — the same file the TUI's Config tab writes. Edit it there (`dario`, Config tab, `s` to save) and restart the unit to apply.

The unit deliberately has **no `EnvironmentFile`**. dario resolves settings as CLI flag > env var > config file > default, so a second env-based surface would silently outrank the file the TUI edits, which is exactly the setup where someone spends an afternoon wondering why a saved setting "isn't taking effect". One source of truth instead.

If you do need an env var for something (an egress proxy that shouldn't live in the config file, say), add a drop-in rather than editing the generated unit — the installer overwrites it on every run:

```bash
systemctl --user edit dario.service
# [Service]
# Environment=DARIO_EGRESS_PROXY=socks5h://127.0.0.1:1080
```

## Staying up after logout

User services stop when your last session ends, unless lingering is enabled:

```bash
loginctl enable-linger "$USER"
```

The installer checks this and warns if it's off, but does not turn it on for you — it changes when your account's services run, which is a decision worth making deliberately.

## What the unit sets, and why

| Directive | Reason |
|---|---|
| `ExecStart=<bun> <repo>/dist/cli.js proxy` | Invokes Bun explicitly rather than relying on the `dario` shim, so the serving process is the MainPID and `SIGTERM` reaches the process that owns the token flush and the listening socket. |
| `TimeoutStopSec=15` | dario force-exits 5s after `SIGTERM` (`src/proxy.ts`). A shorter stop timeout would `SIGKILL` it mid token-flush. |
| `KillMode=control-group` | Stops anything the proxy spawned, not just the leader. |
| `Restart=on-failure`, `RestartSec=3` | Failures here are startup/config errors, not crash loops. Note the overage-guard halt returns 503s without exiting, so a restart will not clear it — use `dario resume` or wait out the cooldown. |
| `ProtectSystem=strict` + `ReadWritePaths=$HOME/.dario` | Read-only filesystem except the one directory dario writes. |
| `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX` | Everything dario needs, nothing else. |

Two hardening options are **deliberately absent**:

- **`MemoryDenyWriteExecute`** would kill the JIT. Bun cannot run under it.
- **`IPAddressAllow`** would break egress proxying. The operator chooses the route (`--egress-proxy`, a VPN, a SOCKS5 endpoint); the unit should not second-guess it. See [`vpn-routing.md`](./vpn-routing.md).

`ProtectHome` is also unset — dario reads `~/.claude*` for device identity and writes `~/.dario`, so hiding `$HOME` breaks it.

If you point `logFile` somewhere outside `~/.dario`, add that path to `ReadWritePaths` via a drop-in, or the write fails under `ProtectSystem=strict`.

## Egress proxies under systemd

With an egress proxy configured, `dario proxy` verifies the route before it serves and exits non-zero if it can't (see [`vpn-routing.md`](./vpn-routing.md)). Under `Restart=on-failure` that means a proxy which is down at boot produces restart attempts rather than a running-but-leaking proxy — which is the behaviour you want, and systemd's default start-rate limit (5 attempts in 10s) puts the unit in `failed` state rather than looping forever.

The common cause is ordering: a local SOCKS5 proxy (a VPN client, an SSH tunnel) that hasn't come up yet. Order against it rather than raising the timeout:

```bash
systemctl --user edit dario.service
# [Unit]
# After=my-vpn.service
# Requires=my-vpn.service
```

`journalctl --user -u dario.service` shows the exact check failure. `--skip-egress-check` starts anyway if you would rather have dario up and returning errors.

## Removing it

```bash
scripts/install-systemd.sh --uninstall   # stop, disable, delete the unit
scripts/install-systemd.sh --purge       # the above, and delete ~/.dario
```

`--uninstall` keeps `~/.dario` — credentials, account pool, and config all survive, so reinstalling picks up where you left off. `--purge` deletes them and asks you to type `purge` to confirm; afterwards you need a fresh `dario login`.

## Upgrading

`dario upgrade` replaces the installed package but does not restart a running service. After upgrading, or after pulling new commits in a checkout:

```bash
bun run build
systemctl --user restart dario.service
```

Re-running `scripts/install-systemd.sh` is also safe — it regenerates the unit (picking up a moved Bun or checkout), reloads, and restarts.
