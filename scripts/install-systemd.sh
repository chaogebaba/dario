#!/usr/bin/env bash
# Install dario as a user-scope systemd service.
#
#   scripts/install-systemd.sh              install, enable, start
#   scripts/install-systemd.sh --uninstall  stop, disable, remove the unit
#   scripts/install-systemd.sh --purge      uninstall AND delete ~/.dario
#
# User scope on purpose: dario reads the calling user's credentials from
# ~/.dario and ~/.claude*, and binds loopback. A system unit would run as
# root or a service account and see neither. Nothing here needs sudo.
#
# The unit runs `bun dist/cli.js proxy` directly rather than going through
# the node shim, so the serving process IS the MainPID — systemd's SIGTERM
# reaches the process that owns the token flush and the listening socket.
#
# Configuration stays in ~/.dario/config.json (the TUI's Config tab writes
# it). There is deliberately no EnvironmentFile: two config surfaces where
# env silently outranks the file is how people end up debugging a setting
# that "isn't taking effect".

set -euo pipefail

UNIT_NAME="dario.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$UNIT_DIR/$UNIT_NAME"
DARIO_HOME="$HOME/.dario"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() { printf '\033[31merror\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m→\033[0m %s\n' "$*"; }
ok() { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }

require_linux_systemd() {
  [ "$(uname -s)" = "Linux" ] || die "user-scope systemd units are Linux-only (found $(uname -s))."
  command -v systemctl >/dev/null 2>&1 || die "systemctl not found — this system does not use systemd."
  # A user manager needs a session bus. Without it, --user silently fails
  # in confusing ways (notably in containers and over plain `su`).
  if [ -z "${XDG_RUNTIME_DIR:-}" ] || [ ! -d "${XDG_RUNTIME_DIR}" ]; then
    die "XDG_RUNTIME_DIR is unset or missing — no systemd user session. Log in normally (not via bare su) and retry."
  fi
  systemctl --user show-environment >/dev/null 2>&1 \
    || die "systemd user manager is not reachable. Try: systemctl --user status"
}

# ── uninstall / purge ────────────────────────────────────────────────
uninstall() {
  local purge="${1:-no}"

  if systemctl --user list-unit-files "$UNIT_NAME" >/dev/null 2>&1 \
     && systemctl --user cat "$UNIT_NAME" >/dev/null 2>&1; then
    info "Stopping and disabling $UNIT_NAME"
    systemctl --user disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
  else
    info "$UNIT_NAME is not installed"
  fi

  if [ -f "$UNIT_PATH" ]; then
    rm -f "$UNIT_PATH"
    ok "Removed $UNIT_PATH"
  fi
  systemctl --user daemon-reload
  systemctl --user reset-failed "$UNIT_NAME" >/dev/null 2>&1 || true

  if [ "$purge" = "purge" ]; then
    if [ -d "$DARIO_HOME" ]; then
      # Credentials and the account pool live here. Deleting them means a
      # fresh `dario login`, so make the user say so twice.
      warn "About to delete $DARIO_HOME — credentials, account pool, and config."
      printf 'Type the word purge to confirm: '
      read -r reply
      [ "$reply" = "purge" ] || die "Not confirmed — nothing deleted."
      rm -rf "$DARIO_HOME"
      ok "Deleted $DARIO_HOME"
    else
      info "No $DARIO_HOME to delete"
    fi
  else
    ok "Kept $DARIO_HOME (credentials and config). Use --purge to remove it."
  fi

  ok "dario service removed."
}

# ── install ──────────────────────────────────────────────────────────
install_service() {
  local bun_bin
  bun_bin="$(command -v bun || true)"
  [ -n "$bun_bin" ] || die "bun not found on PATH. Install from https://bun.sh and retry."
  bun_bin="$(cd "$(dirname "$bun_bin")" && pwd)/$(basename "$bun_bin")"

  # Bun's TLS fingerprint is what dario's wire fidelity rests on; older
  # builds are classified unverified upstream (src/runtime-fingerprint.ts).
  local bun_ver
  bun_ver="$("$bun_bin" --version 2>/dev/null | tr -d '\n')"
  local min="1.3.14"
  if [ "$(printf '%s\n%s\n' "$min" "$bun_ver" | sort -V | head -n1)" != "$min" ]; then
    die "bun $bun_ver is older than the verified floor $min. Upgrade with: bun upgrade"
  fi

  local entry="$REPO_ROOT/dist/cli.js"
  if [ ! -f "$entry" ]; then
    info "Building $REPO_ROOT"
    cd "$REPO_ROOT" || die "cannot enter $REPO_ROOT"
    # Prefer the locked graph; fall back for a checkout whose lockfile is
    # mid-update. Both run in $REPO_ROOT thanks to the cd above.
    bun install --frozen-lockfile >/dev/null 2>&1 || bun install >/dev/null
    bun run build >/dev/null
    cd - >/dev/null || true
  fi
  [ -f "$entry" ] || die "build did not produce $entry"

  mkdir -p "$UNIT_DIR"
  mkdir -p "$DARIO_HOME"
  chmod 700 "$DARIO_HOME" 2>/dev/null || true

  # ProtectSystem=strict makes the whole hierarchy read-only, so ~/.dario
  # needs an explicit exception — that's where tokens are flushed on
  # SIGTERM. MemoryDenyWriteExecute is deliberately absent: it kills the
  # JIT. TimeoutStopSec clears dario's own 5s force-exit.
  cat > "$UNIT_PATH" <<EOF
# Generated by scripts/install-systemd.sh — re-run it to regenerate.
[Unit]
Description=dario — local Claude API proxy
Documentation=https://github.com/askalf/dario
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$bun_bin $entry proxy
WorkingDirectory=$REPO_ROOT
Restart=on-failure
RestartSec=3
TimeoutStopSec=15
KillMode=control-group
StandardOutput=journal
StandardError=journal
SyslogIdentifier=dario

# Hardening. Kept compatible with: the Bun JIT, reading ~/.claude* for
# device identity, writing ~/.dario, and reaching an arbitrary egress
# proxy (so no IPAddressAllow= here — the operator chooses the route).
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectClock=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectHostname=true
RestrictSUIDSGID=true
RestrictRealtime=true
RestrictNamespaces=true
LockPersonality=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
ReadWritePaths=$DARIO_HOME

[Install]
WantedBy=default.target
EOF

  ok "Wrote $UNIT_PATH"

  systemctl --user daemon-reload
  info "Enabling and starting $UNIT_NAME"
  systemctl --user enable --now "$UNIT_NAME"

  # Give it a moment to either come up or fail, so the operator sees the
  # real outcome instead of a premature "started".
  sleep 2
  if systemctl --user is-active --quiet "$UNIT_NAME"; then
    ok "dario is running."
  else
    warn "dario is not active. Recent log:"
    journalctl --user -u "$UNIT_NAME" -n 20 --no-pager || true
    die "service failed to start (often: no credentials yet — run 'dario login')."
  fi

  if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo no)" != "yes" ]; then
    warn "Lingering is off: the service stops when you log out and starts at next login."
    warn "To keep it running across logout:  loginctl enable-linger $USER"
  fi

  cat <<EOF

  Status   systemctl --user status $UNIT_NAME
  Logs     journalctl --user -u $UNIT_NAME -f
  Restart  systemctl --user restart $UNIT_NAME   (after saving config in the TUI)
  Health   curl -fsS http://127.0.0.1:3456/health

  Config lives in $DARIO_HOME/config.json — edit it in \`dario\` (Config tab,
  press s to save) and restart the unit to apply.
EOF
}

main() {
  case "${1:-install}" in
    install|"")   require_linux_systemd; install_service ;;
    --uninstall)  require_linux_systemd; uninstall ;;
    --purge)      require_linux_systemd; uninstall purge ;;
    -h|--help)
      sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      ;;
    *) die "unknown argument: $1 (expected --uninstall, --purge, or no argument)" ;;
  esac
}

main "$@"
