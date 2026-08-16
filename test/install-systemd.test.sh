#!/usr/bin/env bash
# Hermetic tests for scripts/install-systemd.sh.
#
# Everything runs against a temporary HOME with stubbed systemctl /
# loginctl / journalctl on PATH, so the real user manager is never
# touched and no dario service is started. What we assert is the part
# that actually breaks in the field: the generated unit's contents, the
# ordering of the systemctl calls, and that uninstall leaves ~/.dario
# alone unless --purge is given and confirmed.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER="$SCRIPT_DIR/scripts/install-systemd.sh"

pass=0; fail=0
check() {
  if [ "$2" = "0" ]; then printf '  \033[32m✅\033[0m %s\n' "$1"; pass=$((pass+1))
  else printf '  \033[31m❌\033[0m %s\n' "$1"; fail=$((fail+1)); fi
}
contains() { grep -qF -- "$2" "$1" && echo 0 || echo 1; }
header() { printf '\n%s\n  %s\n%s\n' "$(printf '=%.0s' {1..70})" "$1" "$(printf '=%.0s' {1..70})"; }

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

# ── stubs ────────────────────────────────────────────────────────────
STUB_BIN="$SANDBOX/bin"
mkdir -p "$STUB_BIN"
CALLS="$SANDBOX/systemctl.calls"
: > "$CALLS"

cat > "$STUB_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$SYSTEMCTL_CALLS"
case "$*" in
  *show-environment*) exit 0 ;;
  *is-active*)        exit "${STUB_ACTIVE_RC:-0}" ;;
  *"list-unit-files"*|*" cat "*) exit "${STUB_UNIT_EXISTS_RC:-1}" ;;
  *) exit 0 ;;
esac
EOF

cat > "$STUB_BIN/loginctl" <<'EOF'
#!/usr/bin/env bash
echo "${STUB_LINGER:-yes}"
EOF

cat > "$STUB_BIN/journalctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

chmod +x "$STUB_BIN"/*
export SYSTEMCTL_CALLS="$CALLS"

FAKE_HOME="$SANDBOX/home"
mkdir -p "$FAKE_HOME"
FAKE_RUNTIME="$SANDBOX/run"
mkdir -p "$FAKE_RUNTIME"

# The installer legitimately needs a real bun (version floor + build), so
# put its directory on the sandbox PATH. Everything else is stubbed.
BUN_PATH="$(command -v bun || true)"
if [ -z "$BUN_PATH" ]; then
  echo "  (skipped — bun not installed)"
  exit 0
fi
BUN_DIR="$(dirname "$BUN_PATH")"

run_installer() {
  env -i \
    HOME="${OVERRIDE_HOME:-$FAKE_HOME}" \
    USER="${USER:-tester}" \
    PATH="$STUB_BIN:$BUN_DIR:/usr/bin:/bin" \
    XDG_RUNTIME_DIR="$FAKE_RUNTIME" \
    SYSTEMCTL_CALLS="$CALLS" \
    STUB_ACTIVE_RC="${STUB_ACTIVE_RC:-0}" \
    STUB_UNIT_EXISTS_RC="${STUB_UNIT_EXISTS_RC:-1}" \
    STUB_LINGER="${STUB_LINGER:-yes}" \
    bash "$INSTALLER" "$@" 2>&1
}

UNIT="$FAKE_HOME/.config/systemd/user/dario.service"

# ── install ──────────────────────────────────────────────────────────
header 'install writes a valid unit and enables it'
: > "$CALLS"
OUT="$(run_installer install)"
rc=$?
check "installer exits 0" "$rc"
check "unit file created" "$([ -f "$UNIT" ] && echo 0 || echo 1)"

if [ -f "$UNIT" ]; then
  check "runs bun directly (serving process is MainPID)" "$(contains "$UNIT" 'ExecStart=')"
  check "ExecStart invokes the proxy subcommand"        "$(contains "$UNIT" 'proxy')"
  check "Type=simple"                                    "$(contains "$UNIT" 'Type=simple')"
  check "restarts on failure"                            "$(contains "$UNIT" 'Restart=on-failure')"
  # dario force-exits 5s after SIGTERM; the stop timeout must exceed that
  # or systemd SIGKILLs mid token-flush.
  check "TimeoutStopSec exceeds dario's 5s force-exit"   "$(contains "$UNIT" 'TimeoutStopSec=15')"
  check "KillMode=control-group"                         "$(contains "$UNIT" 'KillMode=control-group')"
  check "logs to journal"                                "$(contains "$UNIT" 'StandardOutput=journal')"
  check "ordered after network"                          "$(contains "$UNIT" 'After=network-online.target')"
  check "installed into default.target"                  "$(contains "$UNIT" 'WantedBy=default.target')"

  # Hardening that must be present…
  check "NoNewPrivileges"                                "$(contains "$UNIT" 'NoNewPrivileges=true')"
  check "ProtectSystem=strict"                           "$(contains "$UNIT" 'ProtectSystem=strict')"
  check "dario home writable despite strict"             "$(contains "$UNIT" 'ReadWritePaths=')"

  # …and hardening that must NOT be, because it breaks this workload.
  # Match directives only — the unit's comments mention these by name.
  directive_absent() { grep -qE "^[[:space:]]*$1=" "$UNIT" && echo 1 || echo 0; }
  check "no MemoryDenyWriteExecute (would kill the JIT)" "$(directive_absent MemoryDenyWriteExecute)"
  check "no IPAddressAllow (operator picks the egress route)" "$(directive_absent IPAddressAllow)"
  # A second config surface that silently outranks config.json is a
  # support burden; the unit deliberately has none.
  check "no EnvironmentFile (config.json is the source of truth)" "$(directive_absent EnvironmentFile)"
  # ProtectHome would hide ~/.claude* device identity and ~/.dario alike.
  check "no ProtectHome (dario reads ~/.claude*, writes ~/.dario)" "$(directive_absent ProtectHome)"
fi

check "daemon-reload was issued"     "$(contains "$CALLS" 'daemon-reload')"
check "enable --now was issued"      "$(contains "$CALLS" 'enable --now dario.service')"
check "reports how to follow logs"   "$(printf '%s' "$OUT" | grep -q 'journalctl --user' && echo 0 || echo 1)"

# ── real systemd validation, when available ──────────────────────────
header 'generated unit passes systemd-analyze verify'
if command -v systemd-analyze >/dev/null 2>&1 && [ -f "$UNIT" ]; then
  VERIFY="$(systemd-analyze verify "$UNIT" 2>&1)"
  # Ignore complaints about the ExecStart binary not existing in this
  # sandbox; we care about directive validity.
  FILTERED="$(printf '%s' "$VERIFY" | grep -v -e 'Executable path' -e 'not exist' -e 'Command .* is not executable' || true)"
  check "no directive errors" "$([ -z "$FILTERED" ] && echo 0 || echo 1)"
  [ -n "$FILTERED" ] && printf '      %s\n' "$FILTERED"
else
  echo "  (skipped — systemd-analyze unavailable)"
fi

# ── hostile paths ────────────────────────────────────────────────────
# systemd expands % specifiers in ExecStart/WorkingDirectory/ReadWritePaths
# and splits ExecStart on whitespace. Both are legal in a path, and both
# fail SILENTLY: a checkout under ~/pct%test resolved to
# .../pct/run/user/1000est (%t is the runtime directory) and
# `systemd-analyze verify` returned 0 without a word. Assert on what
# systemd parses, not on what we wrote.
header 'a checkout path containing % or a space survives unit generation'
HOSTILE_HOME="$SANDBOX/pct%test home"
mkdir -p "$HOSTILE_HOME/.config/systemd/user"
HOSTILE_UNIT="$HOSTILE_HOME/.config/systemd/user/dario.service"
: > "$CALLS"
OVERRIDE_HOME="$HOSTILE_HOME" run_installer install >/dev/null 2>&1
if [ -f "$HOSTILE_UNIT" ]; then
  check "unit generated for a hostile path" 0
  # Written escaped…
  check "% is doubled in ExecStart"     "$(contains "$HOSTILE_UNIT" '%%')"
  check "ExecStart paths are quoted"    "$(grep -q 'ExecStart="' "$HOSTILE_UNIT" && echo 0 || echo 1)"
  # …and, where systemd is available, actually parses back to the literal.
  if command -v systemd-analyze >/dev/null 2>&1; then
    PARSED="$(systemd-analyze verify "$HOSTILE_UNIT" 2>&1 || true)"
    check "no specifier expansion warning" \
      "$(printf '%s' "$PARSED" | grep -qi 'specifier' && echo 1 || echo 0)"
  fi
  # The one thing that must never happen: the runtime dir leaking into
  # the path because %t was expanded.
  check "runtime dir did not leak into the unit" \
    "$(grep -q '/run/user/' "$HOSTILE_UNIT" && echo 1 || echo 0)"
else
  check "unit generated for a hostile path" 1
fi

# ── uninstall preserves state ────────────────────────────────────────
header 'uninstall removes the unit but keeps ~/.dario'
mkdir -p "$FAKE_HOME/.dario"
echo '{"port":3456}' > "$FAKE_HOME/.dario/config.json"
echo 'secret' > "$FAKE_HOME/.dario/credentials.json"
: > "$CALLS"
STUB_UNIT_EXISTS_RC=0 run_installer --uninstall >/dev/null 2>&1
check "unit file deleted"                "$([ ! -f "$UNIT" ] && echo 0 || echo 1)"
check "disable --now was issued"         "$(contains "$CALLS" 'disable --now dario.service')"
check "daemon-reload after removal"      "$(contains "$CALLS" 'daemon-reload')"
check "config.json preserved"            "$([ -f "$FAKE_HOME/.dario/config.json" ] && echo 0 || echo 1)"
check "credentials preserved"            "$([ -f "$FAKE_HOME/.dario/credentials.json" ] && echo 0 || echo 1)"

# ── purge requires explicit confirmation ─────────────────────────────
header 'purge deletes ~/.dario only when confirmed'
printf 'no\n' | run_installer --purge >/dev/null 2>&1
check "unconfirmed purge keeps ~/.dario" "$([ -d "$FAKE_HOME/.dario" ] && echo 0 || echo 1)"

printf 'purge\n' | run_installer --purge >/dev/null 2>&1
check "confirmed purge deletes ~/.dario" "$([ ! -d "$FAKE_HOME/.dario" ] && echo 0 || echo 1)"

# ── argument handling ────────────────────────────────────────────────
header 'argument handling'
if run_installer --nonsense >/dev/null 2>&1; then
  check "unknown argument exits non-zero" 1
else
  check "unknown argument exits non-zero" 0
fi

printf '\n%s\n  %d pass, %d fail\n%s\n' \
  "$(printf '=%.0s' {1..70})" "$pass" "$fail" "$(printf '=%.0s' {1..70})"
[ "$fail" -eq 0 ]
