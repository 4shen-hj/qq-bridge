import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function fixture(config = {}, files = {}) {
  const h = await bridgeHarness({ config: { socialV2: { tools: { sendVoice: true }, voice: { enabled: true }, send: { minSendIntervalMs: 0, queueTtlMs: 40, ...config } } }, files,
    globals: {
      inspectAudio: async () => ({ ok: true, size: 32, duration: 1, warnings: [], codec: 'fixture' }),
      safeFetchBuffer: async () => ({ buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]) })
    } });
  h.bot.getGroupMemberList = async () => [{ user_id: 111 }];
  h.setMode('reserved2');
  await h.ensureSession('group:456');
  const server = h.startConsoleServer();
  if (!server.listening) await once(server, 'listening');
  const port = server.address().port;
  const st = h.getSocialV2State('group:456');
  return { h, st, async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await h.close(); },
    async post(route, body, { operator = false, signal } = {}) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', signal,
        headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', ...(operator ? { 'x-console-token': 'fixture-console-token' } : { 'x-agent-token': st.agentToken }) }, body: JSON.stringify(body) });
      return { code: response.status, body: await response.json() };
    }
  };
}
const message = { key: 'group:456', messages: ['fixture'], gapMode: 'none' };

{
  const f = await fixture({ maxSendPerMinute: 1 });
  try {
    const sent = await f.post('/api/socialV2/send-message', message);
    assert.equal(sent.body.sent, 1, JSON.stringify(sent));
    const before = f.st.lastAiReplyAt;
    fs.mkdirSync(path.join(f.h.temp, 'audio'), { recursive: true });
    fs.writeFileSync(path.join(f.h.temp, 'audio/fixture.mp3'), Buffer.alloc(32));
    for (const [route, body, options] of [
      ['/api/socialV2/send-sticker', { key: 'group:456', stickerId: 'fixture-sticker' }],
      ['/api/socialV2/send-voice', { key: 'group:456', voice: 'fixture.mp3', verify: false }],
      ['/api/voice/send', { key: 'group:456', file: 'fixture.mp3', verify: false }, { operator: true }]
    ]) {
      const media = await f.post(route, body, options);
      assert.equal(media.code, 200, JSON.stringify(media));
      assert.equal(media.body.sent, 0, route);
      assert.equal(media.body.reason, 'expired', route);
    }

    const held = await f.post('/api/test-send', { kind: 'private', id: 123, message: 'operator' }, { operator: true });
    assert.equal(held.code, 200); assert.equal(held.body.sent, 0); assert.equal(held.body.reason, 'expired');
    assert.equal(f.h.calls.sent.length, 0, 'operator test shares account limit across targets');
    const poke = await f.post('/api/socialV2/send-poke', { key: 'group:456', targetUserId: '111' });
    assert.equal(poke.code, 200, JSON.stringify(poke)); assert.equal(poke.body.sent, 0);
    assert.equal(f.st.lastAiReplyAt, before, 'cooldown does not record successful action');
    assert.equal(f.st.recentMessages.filter((m) => m.isSelf).length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.h.temp, 'state/outbound-attempts.json'))).attempts.length, 1);
  } finally { await f.close(); }
}

{
  const f = await fixture();
  try {
    const result = await f.post('/api/socialV2/send-message', { ...message, messages: ['first', 'second'], gapMode: 'fixed', gapMs: 100 });
    assert.equal(result.code, 200); assert.equal(result.body.status, 'partial');
    assert.equal(result.body.sent, 1); assert.equal(result.body.unsent, 1); assert.deepEqual(result.body.sentIndices, [0]);
    assert.deepEqual(Array.from(f.st.recentMessages.filter((m) => m.isSelf), (m) => m.text), ['first']);
    assert.ok(f.st.lastAiReplyAt > 0);
    await sleep(120);
    assert.equal(f.h.calls.http.filter((call) => call.url.endsWith('/send_group_msg')).length, 1);
  } finally { await f.close(); }
}

for (const revoke of ['pause', 'tool', 'token', 'silent']) {
  const f = await fixture({ minSendIntervalMs: 1000, queueTtlMs: 1500 });
  try {
    assert.equal((await f.post('/api/socialV2/send-message', message)).body.sent, 1);
    const queued = f.post('/api/socialV2/send-message', message);
    await sleep(20);
    if (revoke === 'pause') f.h.socialV2.paused = true;
    if (revoke === 'tool') f.h.cfg.socialV2.tools.sendMessage = false;
    if (revoke === 'token') f.st.agentToken = 'new-token';
    if (revoke === 'silent') fs.writeFileSync(path.join(f.h.temp, 'state/current-role.json'), JSON.stringify({ mode: 'silent' }));
    const result = await queued;
    assert.equal(result.body.sent, 0, revoke);
    assert.equal(result.body.attempted, 0, revoke);
    assert.equal(f.h.calls.http.filter((call) => call.url.endsWith('/send_group_msg')).length, 1, revoke);
  } finally { await f.close(); }
}

{
  const f = await fixture({ minSendIntervalMs: 1000, queueTtlMs: 1500 });
  try {
    await f.post('/api/socialV2/send-message', message);
    const controller = new AbortController();
    const queued = f.post('/api/socialV2/send-message', message, { signal: controller.signal }).catch((e) => e);
    await sleep(20); controller.abort(); await queued; await sleep(1100);
    assert.equal(f.h.calls.http.filter((call) => call.url.endsWith('/send_group_msg')).length, 1, 'disconnected request never sends later');
    await f.h.sendToQQ('group:456', 'system acknowledgement');
    assert.equal(f.h.calls.sent.length, 1, 'request cancellation context does not leak into system sends');
  } finally { await f.close(); }
}

{
  const time = Date.now();
  const f = await fixture({ maxSendPerMinute: 2 }, { 'state/social-v2.json': { conversations: {
    'group:456': { sendTimes: [time] }, 'private:123': { sendTimes: [time] }
  } } });
  try {
    const migrated = JSON.parse(fs.readFileSync(path.join(f.h.temp, 'state/outbound-attempts.json')));
    assert.deepEqual(migrated.attempts, [time, time], 'startup migrates before conversation rewrite');
    const result = await f.post('/api/socialV2/send-message', message);
    assert.equal(result.body.sent, 0); assert.equal(result.body.reason, 'expired');
  } finally { await f.close(); }
}
{
  const f = await fixture();
  try {
    fs.mkdirSync(path.join(f.h.temp, 'audio'), { recursive: true });
    fs.writeFileSync(path.join(f.h.temp, 'audio/fixture.mp3'), Buffer.alloc(32));
    f.h.cfg.socialV2.voice.maxPerMinute = 1;
    f.h.cfg.socialV2.voice.maxPerHour = 0;
    f.h.voiceSendTimes.set('group:456', [Date.now() - 59000]);
    const cooldown = await f.post('/api/socialV2/send-voice', { key: 'group:456', voice: 'fixture.mp3', verify: false });
    assert.equal(cooldown.code, 200); assert.equal(cooldown.body.reason, 'voice-cooldown');
    assert.ok(cooldown.body.retryAfterMs > 0 && cooldown.body.retryAfterMs <= 1000);
  } finally { await f.close(); }
}

for (const interval of [undefined, 0]) {
  const h = await bridgeHarness({ config: { sendDelayMs: 5000, socialV2: { send: { minSendIntervalMs: interval, maxSendPerMinute: 8 } } } });
  try { assert.equal(h.cfg.socialV2.send.minSendIntervalMs, interval === undefined ? 5000 : 0); }
  finally { await h.close(); }
}

{
  const f = await fixture({ minSendIntervalMs: 1000, queueTtlMs: 1500 });
  try {
    await f.post('/api/socialV2/send-message', message);
    const started = Date.now();
    const sticker = await f.post('/api/socialV2/send-sticker', { key: 'group:456', stickerId: 'fixture-sticker' });
    assert.equal(sticker.body.sent, 1);
    assert.ok(f.st.lastAiReplyAt - started >= 50, 'queued sticker uses completion time');
  } finally { await f.close(); }
}

{
  const h = await bridgeHarness({ config: { socialV2: { send: { minSendIntervalMs: 100, queueTtlMs: 40 } } } });
  try {
    const sent = await h.sendToQQ('group:456', 'x'.repeat(10000));
    assert.equal(sent.length, 1, 'legacy split send returns its successful prefix');
    assert.equal(h.calls.sent.length, 1);
  } finally { await h.close(); }
}
{
  const timestamp = Date.now();
  const originalRename = fs.renameSync;
  let failed;
  try {
    fs.renameSync = (from, to) => {
      if (path.basename(String(to)) === 'outbound-attempts.json') throw new Error('fixture migration write failure');
      return originalRename(from, to);
    };
    failed = await bridgeHarness({ files: { 'state/social-v2.json': { conversations: { 'group:456': { sendTimes: [timestamp] } } } } });
  } finally { fs.renameSync = originalRename; }
  let saved;
  try {
    await assert.rejects(failed.outbound.send({ key: 'group:456', items: [{ transport() { assert.fail('must not send'); } }] }), /migration write failure/);
    saved = JSON.parse(fs.readFileSync(path.join(failed.temp, 'state/social-v2.json')));
    assert.deepEqual(saved.conversations['group:456'].sendTimes, [timestamp]);
  } finally { await failed.close(); }
  const restored = await fixture({ maxSendPerMinute: 1 }, { 'state/social-v2.json': saved });
  try { assert.equal((await restored.post('/api/socialV2/send-message', message)).body.sent, 0); }
  finally { await restored.close(); }
}
console.log('PASS real bridge account quota, operator/poke scope, queued revocation, disconnect and startup migration');
