import assert from 'node:assert/strict';
import { createPromptDelivery } from '../src/prompt-delivery.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const start = (turn) => ({ type: 'turn/start', data: { turn } });
const message = (turn, text = 'fixture completed reply') => ({ type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } });
const end = (turn) => ({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
const receipt = (turn, requestId) => ({ type: 'user/message', data: { turn, message: { source: { kind: 'user', rpcId: requestId } } } });
const accepted = () => ({ result: { ok: true, value: {} } });
async function emit(h, frames) {
  let drained;
  const done = new Promise((resolve) => { drained = resolve; });
  h.api.events.mux = async function* () {
    for (const payload of frames) yield { payload };
    drained();
    await new Promise(() => {});
  };
  void h.pumpMux();
  let timer;
  try { await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture stream did not drain')), 3000); })]); }
  finally { clearTimeout(timer); }
}
const snapshot = (sid, records) => ({ type: 'session/snapshot', sessionId: sid, snapshot: { records } });
const live = (sid, event) => ({ type: 'session/event', sessionId: sid, event });

{
  const store = {};
  const d = createPromptDelivery(store);
  d.snapshot('s', { records: [] });
  d.start('s', 1);
  d.request('s', 'next', 'accepted', { silent: true });
  d.snapshot('s', { records: [start(1)], projections: { values: { inbox: { 'next-turn': [{ source: { rpcId: 'next' } }] } } } });
  assert.equal(d.status('s', 'next'), 'observed');
  assert.equal(d.finish('s', 1).silent, undefined, 'queued next-turn receipt must not silence the current turn');
  d.start('s', 2);
  d.observe('s', receipt(2, 'next'));
  assert.equal(d.finish('s', 2).silent, true);
}
console.log('PASS inbox admission does not bind a future request to the active turn');

{
  const h = await bridgeHarness({ config: { sendDelayMs: 0, allow: { private: ['123', '124'], groups: ['456'] } } });
  try {
    const sid = await h.ensureSession('private:123');
    const attempts = [];
    h.api.sessions.prompt = async (params) => { attempts.push(params); if (attempts.length === 1) throw new Error('fixture response lost after acceptance'); return accepted(); };
    await h.deliverPrompt('private:123', 'same text');
    await h.deliverPrompt('private:123', 'same text');
    await h.flushQueue();
    assert.equal(attempts.length, 1, 'unknown outcome must not be blindly retried or overtaken');
    await h.deliverPrompt('private:124', 'other conversation');
    assert.equal(attempts.length, 2, 'other conversations continue');
    await emit(h, [snapshot(sid, [start(0), message(0, 'old history'), end(0)])]);
    await h.flushQueue();
    assert.equal(attempts.length, 2, 'absence in a bounded snapshot is not proof of non-admission');
    const events = [start(1), receipt(1, attempts[0].requestId), message(1), end(1)];
    await emit(h, [snapshot(sid, events)]);
    await h.flushQueue();
    assert.equal(attempts.length, 3, 'observed admission releases only the next genuine input');
    assert.notEqual(attempts[2].requestId, attempts[0].requestId, 'equal text is not a request identity');
    assert.equal(h.calls.sent.filter((s) => s.text === 'fixture completed reply').length, 1);
    await emit(h, [snapshot(sid, events), ...events.map((e) => live(sid, e))]);
    assert.equal(h.calls.sent.filter((s) => s.text === 'fixture completed reply').length, 1, 'snapshot and live duplicates are suppressed');
  } finally { await h.close(); }
}
console.log('PASS unknown acceptance, per-conversation ordering, bounded snapshot and duplicate suppression');

for (const scenario of ['known-turn', 'first-snapshot-receipt', 'silent', 'tool-sent', 'reset']) {
  const h = await bridgeHarness({ config: { sendDelayMs: 0 } });
  try {
    const key = 'private:123';
    const sid = await h.ensureSession(key);
    await h.deliverPrompt(key, 'fixture accepted request', { silent: scenario === 'silent' });
    const id = h.calls.prompts[0].requestId;
    if (scenario === 'known-turn') h.trackTurnEvent(sid, start(1));
    h.collectors.clear();
    const events = [start(1), ...(scenario === 'known-turn' ? [] : [receipt(1, id)])];
    if (scenario === 'tool-sent') events.push(
      { type: 'tool/call', data: { turn: 1, callId: 'fixture-call', name: 'mcp__snowluma__qq_send_private_message' } },
      { type: 'tool/result', data: { turn: 1, message: { source: { callId: 'fixture-call' }, content: [{ type: 'text', text: '{"ok":true,"sent":1}' }] } } },
    );
    events.push(message(1), end(1));
    if (scenario === 'reset') h.retireSession(key);
    await emit(h, [snapshot(sid, [start(0), message(0, 'old history'), end(0), ...events])]);
    const expected = ['known-turn', 'first-snapshot-receipt'].includes(scenario) ? 1 : 0;
    assert.equal(h.calls.sent.length, expected, scenario);
    await emit(h, [snapshot(sid, events)]);
    assert.equal(h.calls.sent.length, expected, scenario + ' repeated snapshot');
    const saved = JSON.parse(JSON.stringify(h.state));
    const restored = await bridgeHarness({ savedState: saved, config: { sendDelayMs: 0 } });
    try { await emit(restored, [snapshot(sid, events)]); assert.equal(restored.calls.sent.length, 0, 'handled watermark survives reload'); }
    finally { await restored.close(); }
  } finally { await h.close(); }
  console.log('PASS snapshot recovery ' + scenario);
}
