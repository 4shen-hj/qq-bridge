import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runIsolatedConsoleTest, requestConsole, parseConsoleTestArgs } from './test-console.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
let verifiedCleanup = 0;
const observeCleanup = ({ root: fixtureRoot, snapshot }) => {
  for (const [name, bytes] of snapshot) {
    const file = path.join(fixtureRoot, name);
    if (bytes === null) assert.equal(fs.existsSync(file), false, `${name} must remain absent`);
    else assert.deepEqual(fs.readFileSync(file), bytes, `${name} must be restored byte for byte`);
  }
  verifiedCleanup++;
};
await runIsolatedConsoleTest({ observeCleanup });
await runIsolatedConsoleTest({ config: { allow: undefined, deny: undefined, ownerQQ: undefined }, observeCleanup });
for (const failure of ['assertion', 'network']) {
  await assert.rejects(runIsolatedConsoleTest({
    observeCleanup,
    request: async (...args) => {
      const result = await requestConsole(...args);
      if (args[2] === '/api/whitelist' && args[3] === 'POST') {
        if (failure === 'network') throw new Error('simulated network failure after config write');
        return { ...result, body: { ...result.body, ok: false } };
      }
      return result;
    },
  }), failure === 'network' ? /simulated network failure/ : /false !== true/);
}
assert.equal(verifiedCleanup, 4);
assert.throws(() => parseConsoleTestArgs(['--live-send']), /require --live/);
assert.throws(() => parseConsoleTestArgs(['--live', '--target', '456']), /require --live-send/);

function cli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/test-console.mjs', ...args], { cwd: root, env: { ...process.env, ...env }, windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('exit', code => resolve({ code, output }));
  });
}
const isolated = await cli([]);
assert.equal(isolated.code, 0, isolated.output);
assert.match(isolated.output, /isolated fake gateway/);
const requests = [];
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  requests.push({ route: req.url, method: req.method, body: body ? JSON.parse(body) : null });
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  const args = ['--live', '--base', `http://127.0.0.1:${server.address().port}`];
  const env = { QQ_CONSOLE_TEST_TOKEN: 'fixture-only-token' };
  const readOnly = await cli(args, env);
  assert.equal(readOnly.code, 0, readOnly.output);
  assert.equal(requests.length, 4);
  assert.ok(requests.every(r => r.method === 'GET'));
  requests.length = 0;
  const missingTarget = await cli([...args, '--live-send'], env);
  assert.notEqual(missingTarget.code, 0);
  assert.match(missingTarget.output, /explicit QQ ID/);
  assert.equal(requests.length, 0);
  const send = await cli([...args, '--live-send', '--kind', 'private', '--target', '456'], env);
  assert.equal(send.code, 0, send.output);
  const writes = requests.filter(r => r.method === 'POST');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].route, '/api/test-send');
  assert.deepEqual(writes[0].body, { kind: 'private', id: '456', message: '控制台显式发送测试' });
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
console.log('PASS console safety: 4 exact cleanup cases, isolated CLI, read-only live CLI, and explicit simulated send');
