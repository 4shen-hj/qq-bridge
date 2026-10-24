import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

{
  let handler;
  const h = await bridgeHarness({ globals: { http: { createServer(fn) {
    handler = fn;
    return { listen(_port, _host, ready) { ready(); }, on() {}, address() { return { port: 3100 }; } };
  } } } });
  try {
    h.startConsoleServer();
    const request = async (mode, key, headers = {}, method = 'GET') => {
      h.setMode(mode);
      const result = {};
      await handler({ method, url: '/api/socialV2/group-members?key=' + encodeURIComponent(key), headers: {
        host: '127.0.0.1:3100', 'x-console-token': 'fixture-console-token', 'x-agent-call': '1', ...headers,
      } }, { writeHead(status) { result.status = status; }, end(body) { result.body = JSON.parse(body); } });
      return result;
    };
    assert.equal((await request('closed-agent', 'group:456')).body.count, 3);
    assert.equal((await request('closed-agent', 'group:789')).status, 403);
    assert.equal((await request('closed-agent', 'group:456', { 'x-console-token': 'wrong' })).status, 401);
    assert.equal((await request('closed-agent', 'group:456', { 'x-agent-token': 'wrong' })).status, 403);
    assert.equal((await request('closed-agent', 'group:456', {}, 'POST')).status, 403);
    for (const mode of ['chat', 'reserved', 'reserved2']) assert.equal((await request(mode, 'group:456')).status, 403);
    h.setMode('reserved2');
    await h.ensureSession('group:456');
    const token = h.getSocialV2State('group:456').agentToken;
    assert.equal((await request('reserved2', 'group:456', { 'x-agent-token': token })).status, 200);
    assert.equal((await request('reserved2', 'group:789', { 'x-agent-token': token })).status, 403);
  } finally { await h.close(); }
}
console.log('PASS group-members central middleware permission matrix');
