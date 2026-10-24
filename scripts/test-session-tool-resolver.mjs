import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let handler;
const h = await bridgeHarness({ globals: { http: { createServer(fn) {
  handler = fn;
  return { listen(_port, _host, ready) { ready(); }, on() {}, address() { return { port: 3100 }; } };
} } } });

const request = async (url, { method = 'GET', headers = {}, body } = {}) => {
  const req = Object.assign(new EventEmitter(), {
    method, url, headers: {
      host: '127.0.0.1:3100', 'x-console-token': 'fixture-console-token',
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers
    }, pause() {}
  });
  const answer = {};
  const done = handler(req, {
    writeHead(status) { answer.status = status; },
    end(body) { answer.body = body ? JSON.parse(body) : null; }
  });
  if (method === 'POST') queueMicrotask(() => {
    if (body) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  await done;
  return answer;
};

try {
  h.setMode('reserved2');
  h.startConsoleServer();
  assert.equal((await request('/api/console/notify-ai', {
    method: 'POST', body: { key: 'group:456', message: 'fixture reminder' }
  })).status, 200, 'first manual notify creates an authenticated v2 session');
  const id = h.state.sessions['group:456'];
  const token = h.getSocialV2State('group:456').agentToken;
  assert.ok(h.calls.prompts.every((item) => !JSON.stringify(item).includes(token)));
  assert.ok(!h.buildWakePromptV2('group:456', 'bootstrap').includes(token));
  assert.ok(!h.buildWakeReminderPromptV2('group:456').includes(token));
  const endpoint = `/api/internal/session-tool-auth?sessionId=${encodeURIComponent(id)}`;
  const good = await request(endpoint);
  assert.equal(good.status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(good.body)), { ok: true, key: 'group:456', token });
  for (const headers of [
    { 'x-agent-call': '1' }, { 'x-agent-token': token }, { 'x-console-token': 'wrong' }
  ]) assert.notEqual((await request(endpoint, { headers })).status, 200);
  assert.equal((await request('/api/internal/session-tool-auth')).status, 403);
  assert.equal((await request('/api/internal/session-tool-auth?sessionId=forged')).status, 403);
  h.state.sessions['private:123'] = id;
  assert.equal((await request(endpoint)).status, 403, 'duplicate reverse mapping fails closed');
  delete h.state.sessions['private:123'];
  h.socialV2.paused = true;
  assert.equal((await request(endpoint)).status, 403);
  h.socialV2.paused = false;
  h.cfg.socialV2.enabled = false;
  assert.equal((await request(endpoint)).status, 403);
  h.cfg.socialV2.enabled = true;
  h.cfg.allow.groups = [];
  assert.equal((await request(endpoint)).status, 403);
  h.cfg.allow.groups = ['456'];
  h.setMode('chat');
  assert.equal((await request(endpoint)).status, 403);
  h.setMode('reserved2');
  assert.equal((await request(endpoint)).status, 200);

  let releaseList;
  h.api.sessions.list = () => new Promise((resolve) => { releaseList = resolve; });
  const reset = request('/api/workspace/reset', { method: 'POST' });
  for (let i = 0; !releaseList && i < 20; i++) await Promise.resolve();
  assert.ok(releaseList, 'workspace reset reached suspended DSH list');
  assert.equal((await request(endpoint)).status, 403, 'credentials revoked before first DSH await');
  assert.equal((await request('/api/workspace/reset', { method: 'POST' })).status, 409);
  const createdBefore = h.calls.created.length;
  await assert.rejects(h.ensureSession('group:456'), /工作区正在重置/);
  assert.equal(h.calls.created.length, createdBefore, 'no replacement session starts during workspace reset');
  releaseList({ result: { ok: true, value: { items: [] } } });
  assert.equal((await reset).status, 200);
  assert.equal((await request(endpoint)).status, 403);
} finally {
  await h.close();
}

console.log('session resolver auth, policy, ambiguity, and reset race regression passed');
