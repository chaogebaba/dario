// startProxy's bind contract.
//
// It used to return Promise<void> and call process.exit on its caller's
// behalf: 1 for a foreign occupant, and — the damaging one — 0 when the
// occupant answered /health as a healthy dario. A test whose hardcoded port
// was held by the developer's own running dario therefore bound nothing,
// asserted nothing, exited 0, and was scored as a pass by the runner.
//
// It now resolves to a handle carrying the port the kernel actually assigned,
// and rejects with ProxyBindError instead of exiting. Both halves are load-
// bearing: the handle is what lets a suite ask for port 0 and stop colliding,
// and the rejection is what makes a collision observable at all.

import { createServer } from 'node:http';
import { startProxy, ProxyBindError } from '../dist/proxy.js';

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);

const fakeFetch = async () => new Response(JSON.stringify({
  id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
  content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
}), { status: 200, headers: { 'content-type': 'application/json' } });

const baseOpts = {
  host: '127.0.0.1',
  upstreamApiKey: 'sk-ant-test-not-a-real-key',
  noClaudeAuth: true,
  fetchImpl: fakeFetch,
  noLiveCapture: true,
  overageGuardEnabled: false,
};

/** A server that answers /health the way the given body says. */
function occupant(body) {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      if (body === null) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    s.listen(0, '127.0.0.1', () => resolve({ port: s.address().port, close: () => new Promise((r) => s.close(() => r())) }));
  });
}

header('port 0 yields a real, usable port');
const proxy = await startProxy({ ...baseOpts, port: 0 });
check('handle reports a bound port', Number.isInteger(proxy.port) && proxy.port > 0, String(proxy.port));
check('the port is not the one we asked for', proxy.port !== 0);
check('url is built from the bound port', proxy.url === `http://localhost:${proxy.port}`, proxy.url);
check('host is echoed back', proxy.host === '127.0.0.1', proxy.host);
// Not `health.ok`: with --no-claude-auth and an empty pool dario reports
// itself unhealthy and answers 503. That is the correct verdict and beside
// the point here — what is being asserted is that *dario* is on this socket.
const health = await fetch(`http://127.0.0.1:${proxy.port}/health`);
const healthBody = await health.json().catch(() => null);
check('the proxy actually answers there', typeof healthBody?.status === 'string',
  `status ${health.status}, body ${JSON.stringify(healthBody)}`);

header('close releases the socket without exiting the process');
const releasedPort = proxy.port;
await proxy.close();
let rebound = null;
try {
  rebound = await startProxy({ ...baseOpts, port: releasedPort });
  check('the freed port can be bound again', rebound.port === releasedPort);
} catch (err) {
  check('the freed port can be bound again', false, String(err?.message ?? err));
}

header('an occupied port rejects instead of exiting');
{
  const other = await occupant(null); // answers 404, so: not dario
  let caught = null;
  try {
    await startProxy({ ...baseOpts, port: other.port });
  } catch (err) {
    caught = err;
  }
  check('we are still running — startProxy did not exit for us', true);
  check('it threw ProxyBindError', caught instanceof ProxyBindError, caught && caught.constructor?.name);
  check('code is EADDRINUSE', caught?.code === 'EADDRINUSE', caught?.code);
  check('the port is reported back', caught?.port === other.port);
  check('a non-dario occupant is not mistaken for one', caught?.darioAlreadyRunning === false);
  check('and carries no existing-instance detail', caught?.existing === null);
  await other.close();
}

header('an occupant that answers as dario is classified as such');
{
  const other = await occupant({ status: 'ok', oauth: 'healthy', requests: 42 });
  let caught = null;
  try {
    await startProxy({ ...baseOpts, port: other.port });
  } catch (err) {
    caught = err;
  }
  check('still ProxyBindError, not an exit', caught instanceof ProxyBindError);
  check('darioAlreadyRunning is set', caught?.darioAlreadyRunning === true);
  check('oauth status is carried for the CLI banner', caught?.existing?.oauth === 'healthy', JSON.stringify(caught?.existing));
  check('request count is carried too', caught?.existing?.requests === 42);
  await other.close();
}

header('a degraded dario counts as already running');
{
  const other = await occupant({ status: 'degraded', oauth: 'expired', requests: 0 });
  let caught = null;
  try { await startProxy({ ...baseOpts, port: other.port }); } catch (err) { caught = err; }
  check('degraded is still "already running"', caught?.darioAlreadyRunning === true);
  check('an expired oauth status passes the allow-list', caught?.existing?.oauth === 'expired', JSON.stringify(caught?.existing));
  await other.close();
}

header('an unrecognised oauth value is not echoed verbatim');
{
  // The allow-list exists so a hostile or malformed /health cannot put
  // arbitrary text into the operator's terminal via the CLI banner.
  const other = await occupant({ status: 'ok', oauth: 'sk-ant-oat01-leaked', requests: 1 });
  let caught = null;
  try { await startProxy({ ...baseOpts, port: other.port }); } catch (err) { caught = err; }
  check('unknown oauth status is replaced', caught?.existing?.oauth === 'unknown', JSON.stringify(caught?.existing));
  await other.close();
}

if (rebound) await rebound.close();

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
