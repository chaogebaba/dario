/**
 * `dario config` — print effective configuration with credentials redacted.
 *
 * Different from `dario doctor`: doctor is "is it working?", config is
 * "what IS it?". The overlap is intentional — config shows *settings*
 * (port, host, DARIO_API_KEY state, model defaults) that operators
 * need to confirm when debugging a client misconfiguration. Doctor
 * shows *health* (OAuth expiry, template drift, TLS fingerprint
 * match) that operators need to confirm when debugging a routing
 * failure.
 *
 * Every output row is already safe to paste into a bug report:
 * credentials are replaced with `set`/`unset` state tags, paths are
 * left untouched because they're operationally useful, tokens never
 * appear.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveApiKey, type DarioConfig } from './config-file.js';
import { parseOutboundProxy } from './outbound-proxy.js';
import { egressIpUrl } from './egress-ip.js';

import { ignoreCcCredentials } from './oauth.js';
import { homeDir } from './home-dir.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ConfigRow {
  label: string;
  value: string;
}

export interface ConfigSection {
  title: string;
  rows: ConfigRow[];
}

export interface ConfigReport {
  generatedAt: string;
  version: string;
  sections: ConfigSection[];
}

/** Build the config-derived sections without touching disk. */
export function buildRuntimeConfigSections(
  config: DarioConfig,
  env: NodeJS.ProcessEnv = process.env,
): ConfigSection[] {
  const apiKey = resolveApiKey(config, env);
  const rawEgress = env['DARIO_EGRESS_PROXY']
    ?? env['DARIO_UPSTREAM_PROXY']
    ?? config.egressProxy
    ?? '';

  let egressValue: string;
  if (!rawEgress.trim()) {
    egressValue = 'unset — upstream fetches go direct';
  } else {
    try {
      egressValue = parseOutboundProxy(rawEgress)?.display ?? 'unset';
    } catch (err) {
      egressValue = `INVALID — ${(err as Error).message}`;
    }
  }
  const strictTls = triStateEnv(env['DARIO_STRICT_TLS']) ?? config.strictTls;

  return [
    {
      title: 'Proxy (on `dario proxy`)',
      rows: [
        { label: 'port', value: envOrDefault(env, 'DARIO_PORT', String(config.port ?? 3456)) },
        { label: 'host', value: envOrDefault(env, 'DARIO_HOST', config.host ?? '127.0.0.1') },
        { label: 'model', value: envOrDefault(env, 'DARIO_MODEL', config.model || '(passthrough — client picks)') },
        { label: 'effort', value: envOrDefault(env, 'DARIO_EFFORT', config.effort || '(CC default)') },
      ],
    },
    {
      title: 'Egress',
      rows: [
        { label: 'egress proxy', value: egressValue },
        { label: 'ip check', value: egressIpUrl(env, config.egressIpUrl) },
        {
          label: 'on check failure',
          value: env['DARIO_SKIP_EGRESS_CHECK']
            ? 'start anyway (DARIO_SKIP_EGRESS_CHECK)'
            : 'refuse to start',
        },
      ],
    },
    {
      title: 'Auth gate',
      rows: [
        {
          label: 'DARIO_API_KEY',
          value: apiKey
            ? `set (length ${apiKey.length}) — x-api-key / Authorization Bearer required`
            : 'unset — auth not enforced on loopback',
        },
        {
          label: 'DARIO_STRICT_TLS',
          value: strictTls ? 'on' : 'off',
        },
      ],
    },
  ];
}

/**
 * Collect the effective dario configuration the proxy would run with.
 * Reads env vars, filesystem state (credentials, override files, caches),
 * account pool, and configured backends. Never reads the actual
 * credential VALUES — only their presence/absence/path.
 */
export async function collectEffectiveConfig(): Promise<ConfigReport> {
  const sections: ConfigSection[] = [];
  const home = join(homeDir(), '.dario');
  const config = loadConfig().config;

  // ── Identity
  let version = 'unknown';
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as { version?: string };
    version = pkg.version ?? 'unknown';
  } catch { /* noop */ }
  sections.push({
    title: 'Identity',
    rows: [
      { label: 'version', value: `v${version}` },
      { label: 'runtime', value: `${'Bun' in globalThis ? `bun ${(globalThis as { Bun?: { version?: string } }).Bun?.version ?? '?'}` : `node ${process.version} (unsupported)`} on ${process.platform} ${process.arch}` },
    ],
  });

  // ── Effective settings (proxy bind, egress route, auth gate)
  sections.push(...buildRuntimeConfigSections(config));

  // ── OAuth (Claude subscription credentials)
  const credsPath = join(home, 'credentials.json');
  const credsInfo = describeCreds(credsPath);
  sections.push({
    title: 'OAuth',
    rows: [
      { label: 'credentials', value: credsInfo },
      { label: 'path', value: credsPath },
      {
        label: 'DARIO_IGNORE_CC_CREDENTIALS',
        value: ignoreCcCredentials()
          ? "on — using ONLY dario's own credentials.json; Claude Code session token + keychain ignored (won't rotate a live `claude` session)"
          : 'off — also reads ~/.claude/.credentials.json + OS keychain, picks freshest (can rotate a live `claude` session on the same machine)',
      },
    ],
  });

  // ── Pool
  try {
    const { listAccountAliases } = await import('./accounts.js');
    const aliases = await listAccountAliases();
    // Pool-as-primitive (v5.0): the pool is the one credential model. An empty
    // accounts/ dir means either not-logged-in or a `dario login` whose
    // credentials.json hasn't been back-filled into the pool yet (that happens
    // on the next `dario login` / `dario proxy`), so report the pending pool-of-one.
    let mode: string;
    if (aliases.length > 0) {
      mode = `pool of ${aliases.length}`;
    } else {
      const { loadCredentials } = await import('./oauth.js');
      const creds = await loadCredentials();
      mode = creds?.claudeAiOauth?.accessToken
        ? 'pool of 1 (login, not yet materialized)'
        : 'empty (run `dario login`)';
    }
    sections.push({
      title: 'Account pool',
      rows: [
        { label: 'mode', value: mode },
        ...(aliases.length > 0 ? [{ label: 'aliases', value: aliases.join(', ') }] : []),
      ],
    });
  } catch {
    sections.push({
      title: 'Account pool',
      rows: [{ label: 'mode', value: '(check failed)' }],
    });
  }

  // ── Backends
  try {
    const { listBackends } = await import('./openai-backend.js');
    const backends = await listBackends();
    sections.push({
      title: 'OpenAI-compat backends',
      rows: [
        { label: 'count', value: String(backends.length) },
        ...(backends.length > 0
          ? [{ label: 'names', value: backends.map((b) => b.name).join(', ') }]
          : []),
      ],
    });
  } catch {
    sections.push({
      title: 'OpenAI-compat backends',
      rows: [{ label: 'count', value: '(check failed)' }],
    });
  }

  // ── Paths (everything dario reads/writes on disk)
  const pathRows: Array<readonly [label: string, path: string]> = [
    ['home', home],
    ['credentials', credsPath],
    ['accounts', join(home, 'accounts')],
    ['oauth cache', join(home, 'cc-oauth-cache-v6.json')],
    ['oauth override', join(home, 'oauth-config.override.json')],
    ['template cache', join(home, 'template-cache.json')],
  ];
  sections.push({
    title: 'Paths',
    rows: pathRows.map(([label, value]) => ({ label, value })),
  });

  return {
    generatedAt: new Date().toISOString(),
    version,
    sections,
  };
}

function envOrDefault(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  return env[name] ? `${env[name]}  (from ${name})` : fallback;
}

function triStateEnv(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function describeCreds(path: string): string {
  if (!existsSync(path)) return 'not authenticated (run `dario login`)';
  try {
    const s = statSync(path);
    const mode = (s.mode & 0o777).toString(8);
    const age = formatAge(Date.now() - s.mtimeMs);
    return `present (mode ${mode}, last updated ${age} ago)`;
  } catch {
    return 'present (stat failed)';
  }
}

// Exported for unit tests.
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

/**
 * Pretty-print a ConfigReport as aligned ASCII. Same approach as
 * doctor's formatChecks — plain text, no colors, pasteable.
 */
export function formatEffectiveConfig(report: ConfigReport): string {
  const lines: string[] = [];
  for (const section of report.sections) {
    lines.push(`  ${section.title}`);
    lines.push(`  ${'─'.repeat(section.title.length)}`);
    const labelWidth = section.rows.reduce((n, r) => Math.max(n, r.label.length), 0);
    for (const r of section.rows) {
      lines.push(`    ${r.label.padEnd(labelWidth)}  ${r.value}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Structured envelope for `dario config --json`. */
export function formatEffectiveConfigJson(report: ConfigReport): string {
  return JSON.stringify(report, null, 2);
}
