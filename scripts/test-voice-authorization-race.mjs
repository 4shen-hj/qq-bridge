import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { setImmediate as immediate } from 'node:timers/promises';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const key = 'group:456';
const audioInfo = () => ({ ok: true, size: 32, duration: 1, warnings: [], codec: 'fixture' });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

for (const scenario of ['inspect-reset', 'volume-mode', 'queue-reset', 'body-reset', 'same-session-new-token', 'success', 'unrelated-reset']) {
  let handler;
  const entered = deferred();
  const gate = deferred();
  let gatewaySends = 0;
  let cleaned = 0;
  const h = await bridgeHarness({
    config: { sendDelayMs: 0, socialV2: { voice: { enabled: true }, tools: { sendVoice: true }, proactive: { enabled: false } } },
    globals: {
      http: { createServer(fn) {
        handler = fn;
        return { listen(_port, _host, ready) { ready(); }, on() {}, address() { return { port: 3100 }; } };
      } },
      inspectAudio: async () => {
        if (['inspect-reset', 'same-session-new-token', 'unrelated-reset'].includes(scenario)) { entered.resolve(); await gate.promise; }
        return audioInfo();
      },
      processAudioVolume: async (file) => {
        if (scenario === 'volume-mode') { entered.resolve(); await gate.promise; }
        return { path: file + '.converted', converted: true, detail: 'fixture volume', mode: 'volume' };
      },
      cleanupTemp: (_file, converted) => { if (converted) cleaned++; },
      fetch: async (url) => {
        assert.ok(String(url).endsWith('/send_group_msg'));
        gatewaySends++;
        return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
      },
    },
  });
  async function request(url, body, token = null, delayedBody = false) {
    const req = delayedBody ? new Readable({ read() {} }) : Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method: 'POST', url, headers: {
      host: '127.0.0.1:3100', 'content-type': 'application/json', 'x-console-token': 'fixture-console-token',
      ...(token ? { 'x-agent-call': '1', 'x-agent-token': token } : {}),
    } });
    const result = {};
    const done = handler(req, { writeHead(status) { result.status = status; }, end(raw) { result.body = JSON.parse(raw); } });
    if (delayedBody) { entered.resolve(); await gate.promise; req.push(JSON.stringify(body)); req.push(null); }
    await done;
    return result;
  }
  try {
    h.setMode('reserved2');
    const sid = await h.ensureSession(key);
    const token = h.getSocialV2State(key).agentToken;
    if (scenario === 'unrelated-reset') await h.ensureSession('private:123');
    h.startConsoleServer();
    fs.mkdirSync(path.join(h.temp, 'audio'), { recursive: true });
    fs.writeFileSync(path.join(h.temp, 'audio', 'fixture.mp3'), Buffer.alloc(32, 1));
    let blocker;
    if (scenario === 'queue-reset') {
      h.bot.sendGroupMessage = async () => { entered.resolve(); await gate.promise; };
      blocker = h.sendToQQ(key, 'fixture queue blocker');
      await entered.promise;
    }
    const pending = request('/api/socialV2/send-voice', { key, voice: 'fixture.mp3', verify: false }, token, scenario === 'body-reset');
    if (scenario === 'queue-reset') {
      for (let i = 0; i < 5; i++) await immediate();
    } else if (scenario !== 'success') await entered.promise;
    if (scenario === 'volume-mode') {
      assert.equal((await request('/api/mode', { mode: 'chat' })).status, 200);
      assert.equal((await request('/api/mode', { mode: 'reserved2' })).status, 200);
    } else if (scenario === 'same-session-new-token') {
      h.getSocialV2State(key).agentToken = 'fixture-new-generation';
      assert.equal(h.state.sessions[key], sid);
    } else if (scenario !== 'success') {
      assert.equal((await request('/api/session/reset', { key: scenario === 'unrelated-reset' ? 'private:123' : key })).status, 200);
      if (scenario === 'unrelated-reset') {
        assert.equal(h.state.sessions[key], sid);
        assert.equal(h.getSocialV2State(key).agentToken, token);
      }
    }
    gate.resolve();
    const result = await pending;
    await blocker;
    if (scenario === 'success' || scenario === 'unrelated-reset') {
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(gatewaySends, 1);
    } else {
      assert.equal(gatewaySends, 0, `${scenario}: revoked request must never reach the gateway`);
      assert.equal(result.body.ok, false);
      assert.match(result.body.error, /取消|变化|token/);
    }
    if (['volume-mode', 'queue-reset', 'success', 'unrelated-reset'].includes(scenario)) assert.equal(cleaned, 1, 'processed temporary audio is cleaned');
    console.log(`PASS ${scenario}, gateway sends ${gatewaySends}, HTTP ${result.status}`);
  } finally {
    gate.resolve();
    await h.close();
  }
}
