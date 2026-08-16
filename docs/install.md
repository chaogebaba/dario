# Putting `dario` on your PATH

Every instruction in these docs is a `dario` command — `dario login`, `dario doctor`, `dario proxy`, `dario` on its own for the TUI. From a git checkout there is no such command until you make one.

```bash
scripts/install-bin.sh
```

That copies the built output to `~/.local/lib/dario`, writes a launcher to `~/.local/bin/dario` pointing at the copy, and tells you whether that directory is on your PATH (with the line to add if it isn't). `scripts/install-systemd.sh` runs it for you, so installing the service gives you the command too.

```bash
dario --version      # confirm it works
dario                # the TUI
dario doctor         # health report
```

Install elsewhere with `DARIO_BIN_DIR` / `DARIO_LIB_DIR`. `DARIO_BIN_DIR=/usr/local/bin` needs `sudo`, which is why the default is user-scope.

## The copy is the point

`dist/` is often a symlink to somewhere else — a scratch volume, an external drive, a tmpfs — so build output stays off the main filesystem. A launcher that `exec`s through that symlink dies the moment the volume goes away:

```
dario: /path/to/checkout/dist/cli.js is missing
```

So the default install copies `dist/` and `package.json` into `~/.local/lib/dario` and runs *that*. dario has zero runtime dependencies and `dist/` is a couple of megabytes, so the copy is cheap and the installed command depends on nothing but `$HOME` and Bun. Build wherever you like; the thing on your PATH stays put. The installer dereferences symlinks when copying and warns if any survive.

The trade is that a rebuild isn't picked up automatically. After `git pull && bun run build`, re-run `scripts/install-bin.sh` to refresh.

## `--link` for active development

```bash
scripts/install-bin.sh --link
```

Points the launcher straight at the checkout, so every rebuild is live with no reinstall. Right when you're changing code, wrong for anything whose build output lands on removable storage — that's the failure mode above.

Switch back with a plain `scripts/install-bin.sh`.

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

Removes the launcher and the `~/.local/lib/dario` copy, and nothing else — `~/.dario` (credentials, config, account pool) is untouched. `scripts/install-systemd.sh --purge` removes them as well, since at that point you're asking for everything to go.

## Upgrading

`dario upgrade` shells out to `bun add --global`, which installs a release from the registry into Bun's global prefix — a different copy from the one you installed here. It detects that and points you at the right command instead:

```
This dario was installed from a source checkout: /path/to/dario
Refresh from the checkout instead:

  cd /path/to/dario && git pull && bun run build && scripts/install-bin.sh
```

Worth knowing why it bothers: if Bun's bin directory comes earlier on your PATH than `~/.local/bin`, a `bun add --global` would install a release copy that silently shadows yours, and every local change would look like it did nothing.
