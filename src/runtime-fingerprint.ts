/**
 * Runtime TLS-fingerprint detector (direction #3 from the v3.22 roadmap).
 *
 * The Claude Code binary is a Bun-compiled standalone executable, so every
 * HTTPS request it makes goes out through Bun's BoringSSL-derived TLS stack.
 * That ClientHello (JA3/JA4 hash) is what Anthropic's TLS-layer classifier
 * actually sees on the wire.
 *
 * The proxy is a separate process holding its own TLS sessions to
 * api.anthropic.com. Anthropic sees the proxy's TLS fingerprint, not the
 * consumer client's. If the proxy runs under Node, the ClientHello is
 * OpenSSL-shaped — distinct from Bun's BoringSSL shape. That's the JA3
 * gap this module flags.
 *
 * Bun is now a hard requirement: the CLI refuses to start under Node (see
 * the main-entry guard at the bottom of `src/cli.ts`), so proxy mode can
 * no longer silently run on Node's TLS stack. This module makes the
 * runtime status a first-class check: `dario doctor` reports it, proxy
 * startup warns when the axis is mismatched, and `--strict-tls` hard-fails
 * on a Bun version below the JA3-verified floor instead of silently
 * running with a divergent fingerprint.
 *
 * Pure-function: every input is passed in explicitly so tests can
 * exercise each runtime combination without spawning processes.
 */

import { execFileSync } from 'node:child_process';

/** Canonical buckets the caller pivots on. */
export type RuntimeFingerprintStatus =
  /** Running under Bun ≥ the JA3-verified floor — TLS ClientHello matches CC. */
  | 'bun-match'
  /**
   * Running under Bun, but at a version below the JA3-verified floor: being on
   * Bun is necessary but not sufficient. Older Bun ships an older BoringSSL
   * whose ClientHello is not confirmed to match CC's (measured divergent on
   * Bun 1.0.9 — see #813). Treated as a warn so an old Bun on PATH can't
   * report a false-green match while emitting a divergent JA3.
   */
  | 'bun-ja3-unverified'
  /** Running under Node while Bun is on PATH (unreachable from the CLI, which refuses Node). */
  | 'bun-bypassed'
  /** Running under Node, Bun not installed. */
  | 'node-only';

export interface RuntimeFingerprint {
  status: RuntimeFingerprintStatus;
  /** 'bun' or 'node' — which runtime this process is actually on. */
  runtime: 'bun' | 'node';
  /** Version string from the runtime (e.g. "1.1.30" or "v20.11.1"). */
  runtimeVersion: string;
  /** Bun version discovered on PATH, if any. undefined when runtime==='bun' or bun-not-found. */
  availableBunVersion?: string;
  /** Human-readable one-line explanation for the check label. */
  detail: string;
  /** Actionable hint when status !== 'bun-match'. undefined otherwise. */
  hint?: string;
}

/**
 * Probe the Bun binary on PATH without spawning dario. Returns undefined
 * when bun isn't installed or the version probe fails for any reason
 * (timeout, non-zero exit, etc.). Kept synchronous to match cli.ts's
 * pre-import flow; doctor.ts is the only other caller and is fine with
 * the (~sub-100ms) cost when Bun is installed.
 */
export function probeBunVersion(): string | undefined {
  try {
    const out = execFileSync('bun', ['--version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
      encoding: 'utf-8',
    });
    const trimmed = out.trim();
    // `bun --version` prints just the version like "1.1.30". Reject anything
    // longer than a sanity threshold so an unrelated `bun` binary can't
    // poison the detection.
    if (trimmed.length > 0 && trimmed.length < 32 && /^[0-9]/.test(trimmed)) {
      return trimmed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Lowest public Bun version whose TLS ClientHello (JA3) is *measured* to match
 * the Bun/BoringSSL fingerprint Claude Code presents on the wire. Empirical
 * basis (#813, macOS arm64): CC 2.1.214 embeds the Bun canary line and hashes
 * to JA3 `e97f5146a7009cc2918b50e903b6ff8d`; bare public Bun 1.3.14 and canary
 * reproduce it byte-for-byte, while Bun 1.0.9 diverges (adds 3DES, ECH,
 * padding → `2ae7eb4b…`). The window between 1.0.9 and 1.3.14 is unmeasured,
 * so anything below this floor is reported unverified rather than a green match.
 */
export const JA3_VERIFIED_BUN_FLOOR = '1.3.14';

/**
 * True when Bun `version` is at or above `floor`. Parses the leading
 * `major.minor.patch` and ignores any pre-release/`-canary…` suffix, so Bun's
 * canary tags (e.g. `1.4.0-canary.x`) compare as their base triple. Returns
 * `undefined` when either string can't be parsed — the caller decides how to
 * treat "can't tell" (we keep those as a best-effort match rather than warn).
 */
export function bunVersionMeetsJa3Floor(
  version: string,
  floor: string = JA3_VERIFIED_BUN_FLOOR,
): boolean | undefined {
  const parse = (v: string): [number, number, number] | undefined => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
  };
  const a = parse(version);
  const b = parse(floor);
  if (!a || !b) return undefined;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true; // equal versions meet the floor
}

/**
 * Synthesize the TLS-fingerprint status from three inputs. All three are
 * passed explicitly so tests can cover every combination without touching
 * the real environment. Production callers pass
 *   `classifyRuntimeFingerprint(typeof Bun !== 'undefined', probeBunVersion(), process.env)`.
 *
 * The `env` parameter is accepted for signature stability but is not
 * currently read (the old `DARIO_NO_BUN` bypass reason is gone). It is
 * never mutated.
 */
export function classifyRuntimeFingerprint(
  runningUnderBun: boolean,
  availableBunVersion: string | undefined,
  env: Record<string, string | undefined>,
  nodeVersion: string = process.version,
): RuntimeFingerprint {
  if (runningUnderBun) {
    // When we're under Bun, we expose the Bun version if globalThis.Bun.version
    // is readable; we don't require a separate probe. The caller passes the
    // resolved version string as `availableBunVersion` in the bun case.
    const bunVer = availableBunVersion ?? 'unknown';
    // Being on Bun is necessary but NOT sufficient: only Bun ≥ the JA3-verified
    // floor is measured to reproduce CC's ClientHello (#813). A readable version
    // below the floor is the false-green case — dario runs under whatever Bun
    // is on PATH and would otherwise report a match while emitting a
    // divergent JA3. An unreadable version (rare; Bun almost always exposes
    // .version) has nothing to check, so we leave it as a best-effort match.
    if (bunVer !== 'unknown' && bunVersionMeetsJa3Floor(bunVer) === false) {
      return {
        status: 'bun-ja3-unverified',
        runtime: 'bun',
        runtimeVersion: bunVer,
        detail: `Bun v${bunVer} — under Bun, but its TLS ClientHello (JA3) is not verified to match Claude Code (known-good ≥ v${JA3_VERIFIED_BUN_FLOOR})`,
        hint: `Upgrade Bun to ≥ v${JA3_VERIFIED_BUN_FLOOR} (https://bun.sh); older Bun ships an older BoringSSL whose ClientHello diverges from Claude Code's.`,
      };
    }
    return {
      status: 'bun-match',
      runtime: 'bun',
      runtimeVersion: bunVer,
      detail: `Bun v${bunVer} — TLS fingerprint matches Claude Code`,
    };
  }
  if (availableBunVersion !== undefined) {
    return {
      status: 'bun-bypassed',
      runtime: 'node',
      runtimeVersion: nodeVersion,
      availableBunVersion,
      detail: `Node ${nodeVersion} — Bun v${availableBunVersion} on PATH but this process is on Node`,
      hint: 'dario requires the Bun runtime — re-run it under Bun (`bun dario`).',
    };
  }
  return {
    status: 'node-only',
    runtime: 'node',
    runtimeVersion: nodeVersion,
    detail: `Node ${nodeVersion} — Bun not installed; dario requires the Bun runtime`,
    hint:
      'Install Bun (https://bun.sh) — dario requires it; its BoringSSL ClientHello is what ' +
      'matches Claude Code\'s.',
  };
}

/**
 * Convenience wrapper that reads the current process state. doctor.ts
 * calls this once; tests do not — they exercise classifyRuntimeFingerprint
 * directly with synthetic inputs.
 */
export function detectRuntimeFingerprint(): RuntimeFingerprint {
  const bunGlobal = (globalThis as { Bun?: { version?: string } }).Bun;
  const runningUnderBun = typeof bunGlobal?.version === 'string';
  if (runningUnderBun) {
    return classifyRuntimeFingerprint(true, bunGlobal?.version, process.env);
  }
  const probed = probeBunVersion();
  return classifyRuntimeFingerprint(false, probed, process.env);
}

/**
 * The platform-correct upstream Bun install command, as a string.
 *
 * Split out from `bunBootstrap` so callers — and tests — can inspect what
 * WOULD run without running it. Asserting on the command shape used to
 * require calling `bunBootstrap()` itself and relying on a cleared PATH to
 * stop the spawn; that guard does not hold (a `-l` login shell re-sources
 * the profile and restores PATH), so the suite could reach out and execute
 * a network installer on the test machine. A pure function removes the
 * hazard instead of trying to contain it.
 */
export function bunBootstrapArgv(platform: string = process.platform): { cmd: string; args: string[] } {
  return platform === 'win32'
    ? {
        cmd: 'powershell',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://bun.sh/install.ps1 | iex'],
      }
    : { cmd: 'bash', args: ['-lc', 'curl -fsSL https://bun.sh/install | bash'] };
}

export function bunBootstrapCommand(platform: string = process.platform): string {
  const { cmd, args } = bunBootstrapArgv(platform);
  return platform === 'win32'
    ? `${cmd} -NoProfile -ExecutionPolicy Bypass -c "${args[args.length - 1]}"`
    : args[args.length - 1]!;
}

/**
 * One-shot Bun installer. Used by `dario doctor --bun-bootstrap` to
 * close the gap between "Bun warn surfaced" and "Bun on PATH" without
 * making the user copy-paste an install line. Picks the platform-correct
 * upstream installer:
 *
 *   - Windows: `powershell -c "irm https://bun.sh/install.ps1 | iex"`
 *   - macOS / Linux: `curl -fsSL https://bun.sh/install | bash`
 *
 * Streams installer output to the parent stdio so the user sees what's
 * happening (the install can take 10-30 s on a slow link). Returns the
 * exit code; non-zero is surfaced by the caller as a fail row.
 *
 * Pure delegation to the upstream Bun installer — dario does not vendor
 * or self-host the binary. If the user wants a pinned version or doesn't
 * want to run a curl-to-shell installer, the doctor warn line still
 * points at https://bun.sh for manual install.
 *
 * Pinned to bun.sh (not bun.com) because PowerShell's `irm` doesn't
 * follow the bun.com → bun.sh 308 redirect; piping the redirect HTML
 * to `iex` then fails parse. bun.sh serves the install script directly.
 *
 * Side-effecting and network-touching by design: never call this from a
 * test. Assert on `bunBootstrapArgv()` instead — the spawn below is
 * built from it, so those assertions actually constrain what runs. They
 * did not when this function held its own copy of the command: changing
 * the URL here left every test green.
 */
export async function bunBootstrap(): Promise<{ exitCode: number; runner: string }> {
  const { spawn } = await import('node:child_process');
  const runner = bunBootstrapCommand();
  const { cmd, args } = bunBootstrapArgv();

  return await new Promise<{ exitCode: number; runner: string }>((resolve) => {
    // Single-shell invocation so the pipe stages execute the way the
    // upstream installer expects. Avoids reimplementing the curl-pipe-bash
    // sequencing in Node primitives.
    const child = spawn(cmd, args, { stdio: 'inherit' });

    child.on('error', () => resolve({ exitCode: 1, runner }));
    child.on('exit', (code) => resolve({ exitCode: code ?? 1, runner }));
  });
}
