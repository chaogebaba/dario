#!/usr/bin/env bun

import { buildTuiProxySpawn } from '../dist/cli.js';

let pass = 0, fail = 0;
function check(label, condition) {
  if (condition) { console.log(`  PASS ${label}`); pass++;
  } else { console.log(`  FAIL ${label}`); fail++; }
}

const inherited = { PATH: '/bin', DARIO_API_KEY: 'old-key' };
const handoff = buildTuiProxySpawn('--port=4567', 'cli-key', inherited);

check('proxy subcommand is preserved', handoff.childArgs[0] === 'proxy');
check('explicit port is forwarded', handoff.childArgs.includes('--port=4567'));
check('resolved key is installed in the child environment', handoff.childEnv.DARIO_API_KEY === 'cli-key');
check('spawn marker is installed', handoff.childEnv.DARIO_TUI_SPAWNED === '1');
check('API key is absent from argv and process listings', !handoff.childArgs.some((arg) => arg.includes('cli-key')));
check('unrelated environment entries survive', handoff.childEnv.PATH === '/bin');

const withoutKey = buildTuiProxySpawn(undefined, undefined, { PATH: '/usr/bin' });
check('no synthetic key is added when none resolved', withoutKey.childEnv.DARIO_API_KEY === undefined);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
