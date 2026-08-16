# Putting `dario` on your PATH

Every instruction in these docs is a `dario` command — `dario login`, `dario doctor`, `dario proxy`, `dario` on its own for the TUI. From a git checkout there is no such command until you make one.

```bash
scripts/install-bin.sh
```

That writes a launcher to `~/.local/bin/dario` pointing at this checkout, and tells you whether that directory is on your PATH (with the line to add if it isn't). `scripts/install-systemd.sh` runs it for you, so installing the service gives you the command too.

```bash
dario --version      # confirm it works
dario                # the TUI
dario doctor         # health report
```

Install somewhere else with `DARIO_BIN_DIR=/usr/local/bin scripts/install-bin.sh` — that one needs `sudo`, which is why the default is user-scope.

## It points at the checkout, not a copy

Nothing is copied. The launcher `exec`s `bun <checkout>/dist/cli.js "$@"`, so `git pull && bun run build` is picked up on the next run with no reinstall. Move or delete the checkout and the command tells you so:

```
dario: /path/to/dario/dist/cli.js is missing — the checkout moved or was cleaned.
Rebuild with: cd /path/to/dario && bun run build
```

Re-run `scripts/install-bin.sh` from the new location to repoint it.

## Why a wrapper and not a symlink

`dist/cli.js` starts with `#!/usr/bin/env bun`. Symlink it onto PATH on a machine without Bun and you get

```
env: 'bun': No such file or directory
```

and exit 127 — from `env`, before a line of dario's own code runs, so the message that explains dario needs Bun never gets the chance to print. The wrapper pins the absolute path to the Bun it found at install time, falls back to whatever is on PATH, and fails with an explanation when neither exists.

## It won't overwrite someone else's `dario`

If `~/.local/bin/dario` exists and this script didn't write it — an `npm i -g @askalf/dario`, most likely — the installer stops instead of replacing it:

```
error ~/.local/bin/dario already exists and was not written by this script.
```

`--uninstall` follows the same rule: it removes the launcher only if it recognises it, so it can't take out a package-manager install.

Shadowing is the related trap. If another `dario` sits earlier on PATH it keeps winning, and every change you make to the checkout looks like it did nothing. The installer checks and warns:

```
! Another dario is earlier on PATH and wins: /usr/local/bin/dario
```

## Removing it

```bash
scripts/install-bin.sh --uninstall
```

Removes the launcher and nothing else — `~/.dario` (credentials, config, account pool) is untouched. `scripts/install-systemd.sh --purge` removes the launcher as well, since at that point you're asking for everything to go.
