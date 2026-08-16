// Home-directory resolution that behaves the same on every runtime.
//
// Node's `os.homedir()` consults $HOME on POSIX (and %USERPROFILE% on
// Windows) before falling back to the account record. Bun's resolves the
// passwd entry directly and ignores $HOME entirely.
//
// dario runs on Bun, and several supported deployments legitimately
// override HOME rather than matching the passwd entry: containers that
// mount credentials at a custom path and set HOME to it (docs/docker.md),
// systemd units and CI runners that pin HOME, and the test suite, which
// sandboxes HOME to a temp dir.
//
// On Bun all of those silently read the real user's ~/.dario instead —
// the wrong credentials, or none. Reading the env var first restores the
// documented POSIX behavior and makes the two runtimes agree.

import { homedir } from 'node:os';

export function homeDir(): string {
  const fromEnv = process.platform === 'win32'
    ? process.env['USERPROFILE']
    : process.env['HOME'];
  if (fromEnv && fromEnv.trim() !== '') return fromEnv;
  return homedir();
}
