// Tests for the pure helpers in src/config-report.ts
// (`dario config` subcommand). collectEffectiveConfig is covered by an
// end-to-end smoke (`node dist/cli.js config` post-build) since it
// reads filesystem + accounts/backends modules — no point in a
// filesystem-mocked unit test.

import {
  formatAge,
  buildRuntimeConfigSections,
  formatEffectiveConfig,
  formatEffectiveConfigJson,
} from '../dist/config-report.js';
import { defaultConfig } from '../dist/config-file.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

// ─────────────────────────────────────────────────────────────
header('formatAge');
{
  check('<1s → 0s', formatAge(0) === '0s');
  check('30s', formatAge(30_000) === '30s');
  check('59s', formatAge(59_000) === '59s');
  check('1m (60s → 1m)', formatAge(60_000) === '1m');
  check('1h', formatAge(60 * 60_000) === '1h');
  check('1d', formatAge(24 * 60 * 60_000) === '1d');
  check('negative → 0s', formatAge(-5000) === '0s');
}

// ─────────────────────────────────────────────────────────────
header('buildRuntimeConfigSections — precedence and redaction');
{
  const config = defaultConfig();
  config.apiKey = 'file-key';
  config.port = 9876;
  config.host = '0.0.0.0';
  config.model = 'claude-test';
  config.effort = 'high';
  config.strictTls = true;
  config.egressProxy = 'http://alice:secret@proxy.example:8080';
  config.egressIpUrl = 'https://check.example/ip';

  const sections = buildRuntimeConfigSections(config, {});
  const section = (title) => sections.find((candidate) => candidate.title === title);
  const row = (title, label) => section(title)?.rows.find((candidate) => candidate.label === label)?.value;

  check('returns proxy, egress, routing, and auth sections', sections.length === 4);
  check('persisted proxy values are reported',
    row('Proxy (on `dario proxy`)', 'port') === '9876'
      && row('Proxy (on `dario proxy`)', 'host') === '0.0.0.0'
      && row('Proxy (on `dario proxy`)', 'model') === 'claude-test'
      && row('Proxy (on `dario proxy`)', 'effort') === 'high');
  check('persisted strict TLS setting is reported', row('Auth gate', 'DARIO_STRICT_TLS') === 'on');
  check('persisted API key is reported by length', row('Auth gate', 'DARIO_API_KEY')?.includes('length 8'));
  check('API key value is never reported', !JSON.stringify(sections).includes('file-key'));
  check('egress credentials are redacted', row('Egress', 'egress proxy') === 'http://***:***@proxy.example:8080/');
  check('configured IP check is reported', row('Egress', 'ip check') === 'https://check.example/ip');
  check('routing defaults are reported',
    row('Routing', 'pool strategy') === 'headroom'
      && row('Routing', 'session affinity') === 'on'
      && row('Routing', 'Claude session source') === 'header');

  const envSections = buildRuntimeConfigSections(config, {
    DARIO_API_KEY: 'environment-key',
    DARIO_PORT: '4567',
    DARIO_STRICT_TLS: '1',
    DARIO_EGRESS_PROXY: '',
    DARIO_POOL_STRATEGY: 'round-robin',
    DARIO_SESSION_AFFINITY: '0',
    DARIO_SESSION_AFFINITY_CLAUDE_SOURCE: 'body',
  });
  const envSection = (title) => envSections.find((candidate) => candidate.title === title);
  const envRow = (title, label) => envSection(title)?.rows.find((candidate) => candidate.label === label)?.value;
  check('environment API key wins', envRow('Auth gate', 'DARIO_API_KEY')?.includes('length 15'));
  check('proxy environment source is retained', envRow('Proxy (on `dario proxy`)', 'port') === '4567  (from DARIO_PORT)');
  check('strict TLS environment flag is retained', envRow('Auth gate', 'DARIO_STRICT_TLS') === 'on');
  check('empty primary egress env disables persisted proxy', envRow('Egress', 'egress proxy') === 'unset — upstream fetches go direct');
  check('routing environment overrides are reported',
    envRow('Routing', 'pool strategy') === 'round-robin  (from DARIO_POOL_STRATEGY)'
      && envRow('Routing', 'session affinity') === 'off  (from DARIO_SESSION_AFFINITY)'
      && envRow('Routing', 'Claude session source') === 'body  (from DARIO_SESSION_AFFINITY_CLAUDE_SOURCE)');
  check('invalid strict TLS env falls through to persisted config',
    row('Auth gate', 'DARIO_STRICT_TLS') === 'on'
      && buildRuntimeConfigSections({ ...config, strictTls: true }, { DARIO_STRICT_TLS: 'garbage' })
        .find((candidate) => candidate.title === 'Auth gate')?.rows.find((candidate) => candidate.label === 'DARIO_STRICT_TLS')?.value === 'on');
}

// ─────────────────────────────────────────────────────────────
header('formatEffectiveConfig — shape');
{
  const report = {
    generatedAt: '2026-04-23T00:00:00.000Z',
    version: '3.31.9',
    sections: [
      {
        title: 'Identity',
        rows: [
          { label: 'version', value: 'v3.31.9' },
          { label: 'runtime', value: 'node v22 on linux' },
        ],
      },
      {
        title: 'Auth gate',
        rows: [
          { label: 'DARIO_API_KEY', value: 'unset' },
          { label: 'longer_label',  value: 'on' },
        ],
      },
    ],
  };
  const out = formatEffectiveConfig(report);
  check('contains first section title',  out.includes('Identity'));
  check('contains second section title', out.includes('Auth gate'));
  check('contains a divider line',       out.includes('────────'));
  check('contains values',               out.includes('v3.31.9') && out.includes('unset'));

  // Rows within the same section are aligned — the shorter label gets
  // padded to the width of the longer one, so the VALUE column is at
  // the same index across rows. Longer of the two test labels is
  // "DARIO_API_KEY" (13 chars). Value starts at: 4 (leading indent) +
  // 13 (padded label) + 2 (separator) = column 19.
  const EXPECTED_VALUE_COL = 4 + 13 + 2;
  const authLines = out.split('\n').filter((l) => /DARIO_API_KEY|longer_label/.test(l));
  check('both Auth gate rows rendered', authLines.length === 2);
  if (authLines.length === 2) {
    const row1Value = authLines[0].slice(EXPECTED_VALUE_COL);
    const row2Value = authLines[1].slice(EXPECTED_VALUE_COL);
    check('row 1 value at expected column (starts with "unset")', row1Value.startsWith('unset'));
    check('row 2 value at expected column (starts with "on")',    row2Value.startsWith('on'));
  }
}

header('formatEffectiveConfig — empty sections');
{
  const out = formatEffectiveConfig({
    generatedAt: '2026-04-23T00:00:00.000Z',
    version: '3.31.9',
    sections: [],
  });
  check('empty sections → empty-ish output', out.trim() === '');
}

// ─────────────────────────────────────────────────────────────
header('formatEffectiveConfigJson — round-trip');
{
  const report = {
    generatedAt: '2026-04-23T00:00:00.000Z',
    version: '3.31.9',
    sections: [
      { title: 'S1', rows: [{ label: 'a', value: 'b' }] },
    ],
  };
  const parsed = JSON.parse(formatEffectiveConfigJson(report));
  check('version field round-trips',      parsed.version === '3.31.9');
  check('sections array length preserved', Array.isArray(parsed.sections) && parsed.sections.length === 1);
  check('row round-trips',                 parsed.sections[0].rows[0].label === 'a' && parsed.sections[0].rows[0].value === 'b');
}

// ─────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
