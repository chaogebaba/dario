#!/usr/bin/env bash
# Hermetic tests for scripts/install-bin.sh.
#
# Everything runs against a temporary bin dir via DARIO_BIN_DIR, so the
# operator's real ~/.local/bin is never written. What we assert is what
# actually breaks in the field: that the generated launcher survives paths
# with spaces and quotes, that it never silently replaces someone else's
# `dario` (an npm global is the common one), and that the bun-missing and
# checkout-moved cases fail with an explanation rather than a bare 127
# from `env`.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER="$SCRIPT_DIR/scripts/install-bin.sh"

pass=0; fail=0
check() {
  if [ "$2" = "0" ]; then printf '  \033[32m✅\033[0m %s\n' "$1"; pass=$((pass+1))
  else printf '  \033[31m❌\033[0m %s\n' "$1"; fail=$((fail+1)); fi
}
header() { printf '\n%s\n  %s\n%s\n' "$(printf '=%.0s' {1..70})" "$1" "$(printf '=%.0s' {1..70})"; }
yn() { if [ "$1" = 0 ]; then echo 0; else echo 1; fi; }

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

# The installer builds when dist/cli.js is absent. The repo under test is
# already built by the time the suite runs, so this never triggers — but
# skip loudly rather than silently building inside a test.
if [ ! -f "$SCRIPT_DIR/dist/cli.js" ]; then
  echo "SKIP: dist/cli.js not built; run 'bun run build' first." >&2
  exit 0
fi

run_installer() {
  local bindir="$1"; shift
  DARIO_BIN_DIR="$bindir" bash "$INSTALLER" "$@" 2>&1
}

# ======================================================================
header 'install — writes an executable launcher that runs'
{
  BIN="$SANDBOX/plain/bin"
  out="$(run_installer "$BIN")"; rc=$?
  check 'installer exits 0' "$(yn $rc)"
  check 'launcher exists' "$(yn "$([ -f "$BIN/dario" ] && echo 0 || echo 1)")"
  check 'launcher is executable' "$(yn "$([ -x "$BIN/dario" ] && echo 0 || echo 1)")"
  check 'reports where it points' "$(yn "$(grep -q "dist/cli.js" <<<"$out" && echo 0 || echo 1)")"

  # The whole point of the exercise: the command runs.
  ver="$("$BIN/dario" --version 2>/dev/null)"
  check 'launcher runs and prints a version' "$(yn "$(grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+' <<<"$ver" && echo 0 || echo 1)")"

  # Arguments and exit codes have to survive the wrapper, or every script
  # that shells out to dario breaks in a way the wrapper hides.
  if "$BIN/dario" definitely-not-a-real-subcommand >/dev/null 2>&1; then
    check 'a failing subcommand still exits non-zero' 1
  else
    check 'a failing subcommand still exits non-zero' 0
  fi
}

# ======================================================================
header 'install — refuses to clobber a foreign dario'
{
  BIN="$SANDBOX/foreign/bin"
  mkdir -p "$BIN"
  printf '#!/bin/sh\necho npm-installed dario\n' > "$BIN/dario"
  chmod +x "$BIN/dario"

  out="$(run_installer "$BIN")"; rc=$?
  check 'installer fails rather than overwriting' "$(yn "$([ $rc -ne 0 ] && echo 0 || echo 1)")"
  check 'says why' "$(yn "$(grep -q "not written by this script" <<<"$out" && echo 0 || echo 1)")"
  check 'the foreign file is untouched' \
    "$(yn "$(grep -q "npm-installed dario" "$BIN/dario" && echo 0 || echo 1)")"

  # Uninstall has the same rule. A --uninstall that deletes whatever is
  # named `dario` would take out the user's package-manager install.
  out="$(run_installer "$BIN" --uninstall)"; rc=$?
  check 'uninstall refuses to delete it' "$(yn "$([ $rc -ne 0 ] && echo 0 || echo 1)")"
  check 'the foreign file survives uninstall' \
    "$(yn "$([ -f "$BIN/dario" ] && echo 0 || echo 1)")"
}

# ======================================================================
header 'uninstall — removes only what we wrote'
{
  BIN="$SANDBOX/clean/bin"
  run_installer "$BIN" >/dev/null 2>&1
  out="$(run_installer "$BIN" --uninstall)"; rc=$?
  check 'uninstall exits 0' "$(yn $rc)"
  check 'launcher is gone' "$(yn "$([ ! -e "$BIN/dario" ] && echo 0 || echo 1)")"

  # Idempotent: a second uninstall is not an error.
  out="$(run_installer "$BIN" --uninstall)"; rc=$?
  check 'uninstall is idempotent' "$(yn $rc)"
  check 'says there was nothing to remove' \
    "$(yn "$(grep -q "No launcher" <<<"$out" && echo 0 || echo 1)")"
}

# ======================================================================
header 'hostile paths — spaces and quotes in the bin dir'
{
  # The repo path is interpolated into a generated shell script, so it has
  # to be quoted, not merely escaped-looking. A checkout under "my projects"
  # is the ordinary case; the apostrophe is the one that breaks naive
  # single-quoting.
  BIN="$SANDBOX/dir with spaces/and'quote/bin"
  out="$(run_installer "$BIN")"; rc=$?
  check 'installs under a path with spaces and a quote' "$(yn $rc)"
  ver="$("$BIN/dario" --version 2>/dev/null)"
  check 'and the launcher still runs' \
    "$(yn "$(grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+' <<<"$ver" && echo 0 || echo 1)")"

  # bash -n catches a quoting bug that happens not to trigger on this path.
  bash -n "$BIN/dario"
  check 'generated launcher is syntactically valid' "$(yn $?)"
}

# ======================================================================
header 'runtime failures explain themselves'
{
  BIN="$SANDBOX/runtime/bin"
  run_installer "$BIN" >/dev/null 2>&1

  # The checkout moved or was cleaned. Without the guard this is an
  # inscrutable error from bun about a missing file.
  launcher="$SANDBOX/runtime/moved-dario"
  sed "s#^ENTRY=.*#ENTRY='$SANDBOX/nope/cli.js'#" "$BIN/dario" > "$launcher"
  chmod +x "$launcher"
  out="$("$launcher" --version 2>&1)"; rc=$?
  check 'a missing entry point exits 127' "$(yn "$([ $rc -eq 127 ] && echo 0 || echo 1)")"
  check 'and names the rebuild command' \
    "$(yn "$(grep -q "bun run build" <<<"$out" && echo 0 || echo 1)")"

  # bun gone entirely. `#!/usr/bin/env bun` would give a bare
  # "env: 'bun': No such file or directory" here; the wrapper exists so
  # the message names the runtime and where to get it.
  launcher="$SANDBOX/runtime/nobun-dario"
  # SC2016: the sed script edits a literal `$BUN` in the generated file —
  # expanding it here is exactly what must not happen.
  # shellcheck disable=SC2016
  sed -e "s#^BUN=.*#BUN='$SANDBOX/nope/bun'#" \
      -e 's#^\[ -x "\$BUN" \].*#[ -x "$BUN" ] || BUN=""#' "$BIN/dario" > "$launcher"
  chmod +x "$launcher"
  out="$("$launcher" --version 2>&1)"; rc=$?
  check 'a missing bun exits 127' "$(yn "$([ $rc -eq 127 ] && echo 0 || echo 1)")"
  check 'and points at bun.sh' \
    "$(yn "$(grep -q "bun.sh" <<<"$out" && echo 0 || echo 1)")"
}

# ======================================================================
header 'PATH guidance'
{
  BIN="$SANDBOX/pathcheck/bin"
  out="$(PATH="$PATH" run_installer "$BIN")"
  check 'warns when the bin dir is not on PATH' \
    "$(yn "$(grep -q "is not on PATH" <<<"$out" && echo 0 || echo 1)")"

  out="$(PATH="$BIN:$PATH" run_installer "$BIN")"
  check 'confirms when the bin dir IS on PATH' \
    "$(yn "$(grep -q "is on PATH" <<<"$out" && echo 0 || echo 1)")"
}

# ======================================================================
header 'argument handling'
{
  out="$(run_installer "$SANDBOX/args/bin" --help)"
  check '--help prints usage' "$(yn "$(grep -q "install-bin.sh" <<<"$out" && echo 0 || echo 1)")"
  check '--help does not install' \
    "$(yn "$([ ! -e "$SANDBOX/args/bin/dario" ] && echo 0 || echo 1)")"

  out="$(run_installer "$SANDBOX/args/bin" --wat)"; rc=$?
  check 'an unknown flag is rejected' "$(yn "$([ $rc -ne 0 ] && echo 0 || echo 1)")"
}

printf '\n%s\n  %d pass, %d fail\n%s\n' \
  "$(printf '=%.0s' {1..70})" "$pass" "$fail" "$(printf '=%.0s' {1..70})"
[ "$fail" -eq 0 ]
