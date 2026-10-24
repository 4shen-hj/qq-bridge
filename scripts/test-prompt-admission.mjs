import assert from 'node:assert/strict';
import * as roleCard from '../src/role-card.js';
import { NodeApiClient } from '../src/dsh-client.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const accepted = () => ({ result: { ok: true, value: {} } });

{
  const h = await bridgeHarness({ config: { sendDelayMs: 0 }, globals: roleCard });
  try {
    await h.ensureSession('private:123');
    const attempts = [];
    h.api.sessions.prompt = async (params) => {
      attempts.push(params);
      if (attempts.length === 1) throw Object.assign(new Error('fixture connection refused'), { delivery: 'not-sent' });
      return accepted();
    };
    await h.handleIncoming('private', 123, { user_id: 123, message_id: 1, message: [{ type: 'text', data: { text: 'fixture ordinary input' } }] }, h.cfg);
    await h.flushQueue();
    assert.equal(attempts.length, 2, 'ordinary message is recovered after definite non-admission');
    assert.equal(attempts[0].requestId, attempts[1].requestId);
    assert.ok(attempts[0].requestId);
  } finally { await h.close(); }
}
console.log('PASS ordinary input retries definite non-admission with stable identity');

{
  const h = await bridgeHarness();
  try {
    h.setReady(false);
    await h.deliverPrompt('private:123', 'first');
    await h.deliverPrompt('private:123', 'second');
    h.setReady(true);
    const attempts = [];
    h.api.sessions.prompt = async (p) => { attempts.push(p); if (attempts.length === 1) throw Object.assign(new Error('not sent'), { delivery: 'not-sent' }); return accepted(); };
    await h.flushQueue();
    assert.equal(attempts.length, 1, 'failed head stops this conversation recovery');
    await h.flushQueue();
    assert.equal(attempts.length, 3);
    assert.equal(attempts[0].requestId, attempts[1].requestId);
    assert.match(attempts[2].content[0].text, /second/);
  } finally { await h.close(); }
}
console.log('PASS failed recovery head retains order and identity');

{
  const h = await bridgeHarness();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let began;
  const entered = new Promise((resolve) => { began = resolve; });
  try {
    h.setReady(false);
    await h.deliverPrompt('private:123', 'first');
    await h.deliverPrompt('private:123', 'second');
    h.setReady(true);
    const texts = [];
    h.api.sessions.prompt = async (p) => {
      texts.push(p.content[0].text);
      if (texts.length === 1) { began(); await gate; }
      return accepted();
    };
    const flushing = h.flushQueue();
    await entered;
    const incoming = h.deliverPrompt('private:123', 'third');
    release();
    await flushing;
    await incoming;
    await h.flushQueue();
    assert.deepEqual(texts.map((text) => text.split('\n').at(-1)), ['first', 'second', 'third'], 'new input cannot overtake a recovery batch');
  } finally { release(); await h.close(); }
}
console.log('PASS input arriving during a recovery RPC stays behind the backlog');

{
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    await h.ensureSession('group:456');
    const st = h.getSocialV2State('group:456');
    st.wakeConfig.infinite = false;
    st.wakeConfig.sleepUntil = new Date(Date.now() - 1000).toISOString();
    let attempts = 0;
    h.api.sessions.prompt = async () => { attempts++; throw new Error('response lost after admission'); };
    await h.sendWakePromptV2('group:456', 'timeout');
    assert.equal(st.wakeRetry, null, 'unknown wake acceptance leaves the bounded retry loop');
    await h.flushQueue();
    assert.equal(attempts, 1, 'unknown wake acceptance must not issue a second prompt');
  } finally { await h.close(); }
}
console.log('PASS unknown wake acceptance waits for a receipt');

{
  const client = new NodeApiClient('http://127.0.0.1:1', undefined, {});
  const requests = [];
  client.postJson = async (_url, request) => { requests.push(request); return { json: async () => ({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: {} } }) }; };
  for (let i = 0; i < 2; i++) await client.callUnary('session/prompt', { sessionId: 'fixture', requestId: 'stable-fixture-id', mode: 'queue', content: [] });
  assert.equal(requests[0].rpcId, requests[1].rpcId);
  assert.equal(requests[0].payload.args.request.requestId, 'stable-fixture-id');
  client.postJson = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
  await assert.rejects(client.callUnary('session/prompt', {}), (error) => error.delivery === 'not-sent');
  client.postJson = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); };
  await assert.rejects(client.callUnary('session/prompt', {}), (error) => error.delivery === undefined);
}
console.log('PASS real client correlation and transport outcome classification');
