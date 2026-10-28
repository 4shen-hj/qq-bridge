import assert from 'node:assert/strict';
import test from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const malformed = {
  kind: 'error',
  error: { code: 'MALFORMED_RESPONSE', message: 'DeepSeek Messages stream: tool input is invalid JSON' },
};
const assistant = (turn, text) => ({ type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } });
const started = (turn) => ({ type: 'turn/start', data: { turn } });
const ended = (turn, reason) => ({ type: 'turn/end', data: { turn, reason } });
const clone = (value) => JSON.parse(JSON.stringify(value));

async function fixture(mode = 'reserved2', options = {}) {
  const logs = [];
  const h = await bridgeHarness({
    config: { socialV2: { proactive: { enabled: false }, wake: { noActionLimit: 3, maxWakeConfigReminders: 2 } } },
    globals: { console: { log: (...parts) => logs.push(parts.join(' ')), error: (...parts) => logs.push(parts.join(' ')) } },
  });
  h.setMode(mode);
  const key = mode === 'closed-agent' ? 'private:123' : 'group:456';
  const sid = await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  if (options.wake) await h.sendWakePromptV2(key, 'bootstrap');
  return { h, key, sid, st, logs };
}

async function emit({ h, sid }, events) {
  let drained;
  const done = new Promise((resolve) => { drained = resolve; });
  h.api.events.mux = async function* () {
    for (const event of events) yield { payload: { type: 'session/event', sessionId: sid, event } };
    drained();
    await new Promise(() => {});
  };
  void h.pumpMux();
  let timer;
  try {
    await Promise.race([done, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('event handler did not drain the fixture stream')), 3000);
    })]);
  } finally { clearTimeout(timer); }
}

for (const mode of ['reserved', 'reserved2']) {
  test(`${mode} keeps malformed tool JSON local and excludes failed assistant text`, async () => {
    const f = await fixture(mode);
    try {
      await emit(f, [started(1), assistant(1, '这条失败回合的文本不能发到 QQ'), ended(1, malformed)]);
      assert.equal(f.h.calls.sent.length, 0, 'malformed tool JSON must not be sent to a simulation conversation');
      assert.ok(f.logs.some((line) => line.includes('MALFORMED_RESPONSE')), 'local diagnostics retain the error code');
      assert.ok(f.logs.some((line) => line.includes(f.sid) && line.includes('"turn":1')), 'local diagnostics identify the failed turn');
      assert.equal(f.h.calls.prompts.length, 0, 'terminal failure must not replay the user turn');
    } finally { await f.h.close(); }
  });
}

for (const mode of ['chat', 'closed-agent']) {
  test(`${mode} sends a generic failure notice without internal diagnostics`, async () => {
    const f = await fixture(mode);
    try {
      await emit(f, [started(1), assistant(1, '失败文本'), ended(1, malformed)]);
      assert.equal(f.h.calls.sent.length, 1, 'an explicit conversation gets one failure notice');
      assert.doesNotMatch(f.h.calls.sent[0].text, /DeepSeek|JSON|tool input|MALFORMED|失败文本/);
    } finally { await f.h.close(); }
  });
}

for (const reason of [malformed, { kind: 'error', error: { code: 'AUTH', message: 'Authentication failed' } }, { kind: 'aborted' }]) {
  test(`${reason.kind === 'error' ? reason.error.code : reason.kind} releases wake leases without behavioral penalties`, async () => {
    const f = await fixture('reserved2', { wake: true });
    const { h, key, sid, st } = f;
    try {
      h.appendSocialV2Message(key, 'fixture', '仍未读', '仍未读', false, false, 'message-1', [], '111');
      st.lastReadThroughSeq = 1;
      st.wakeConfig.noActionCount = 2;
      st.wakeConfig.triggers.keywords = ['保留关键词'];
      st.wakeConfig.triggers.probability = 0.04;
      h.wakeConfigMissCount.set(key, 1);
      const before = { wakeConfig: clone(st.wakeConfig), unread: clone(st.unread), lastReadThroughSeq: st.lastReadThroughSeq };
      const promptsBefore = h.calls.prompts.length;
      await emit(f, [started(7), assistant(7, '失败回合内容'), ended(7, reason)]);
      assert.deepEqual(clone(st.wakeConfig), before.wakeConfig, 'failure must not increment noActionCount or reset configuration');
      assert.equal(h.wakeConfigMissCount.get(key), 1, 'failure must not change missing-close penalties');
      assert.deepEqual(clone(st.unread), before.unread, 'failure must not mark unread messages read');
      assert.equal(st.lastReadThroughSeq, before.lastReadThroughSeq);
      assert.equal(h.calls.prompts.length, promptsBefore, 'failure must not create a close reminder or replay');
      assert.equal(h.pendingWakeKeys.has(key), false);
      assert.equal(h.pendingWakeLeaseTimers.has(key), false);
      assert.equal(h.collectors.has(sid), false);
      assert.equal(h.v2TurnStartAt.has(sid), false);
      assert.equal(h.isConversationBusyV2(key, st), false, 'later messages must remain wakeable');
      await h.sendWakePromptV2(key, 'atMention');
      assert.equal(h.calls.prompts.length, promptsBefore + 1, 'a genuine later wake is still delivered');
    } finally { await h.close(); }
  });
}

test('terminal errors clear successful-action markers without changing an already updated configuration', async () => {
  const f = await fixture('reserved2', { wake: true });
  const { h, key, sid, st } = f;
  try {
    await h.sendToQQ(key, '此前步骤已经发出');
    h.wakeConfigUpdatedKeys.add(key);
    h.markReadCalledKeys.add(key);
    st.wakeConfig.noActionCount = 2;
    st.wakeConfig.infinite = true;
    st.wakeConfig.triggers.atMention = false;
    const before = clone(st.wakeConfig);
    await emit(f, [started(8),
      { type: 'tool/call', data: { turn: 8, callId: 'sent-call', name: 'mcp__snowluma__qq_send_message', arguments: { messages: ['已发送'] } } },
      { type: 'tool/result', data: { turn: 8, message: { source: { callId: 'sent-call' }, content: [{ type: 'text', text: '{"ok":true,"sent":1}' }] } } },
      { type: 'tool/call', data: { turn: 8, callId: 'pending-call', name: 'mcp__snowluma__qq_send_message', arguments: {} } },
      ended(8, malformed),
    ]);
    assert.deepEqual(clone(st.wakeConfig), before, 'terminal errors must preserve even a successful earlier step configuration');
    assert.equal(h.wakeConfigUpdatedKeys.has(key), false);
    assert.equal(h.markReadCalledKeys.has(key), false);
    assert.equal(h.sendToolSucceededSessions.has(sid), false);
    assert.equal(h.pendingSendToolCalls.has(sid), false);
    assert.equal(h.toolCallNames.has(sid), false);
    assert.deepEqual(h.calls.sent.map(({ text }) => text), ['此前步骤已经发出'], 'earlier tool sends must not be duplicated by terminal error handling');
  } finally { await h.close(); }
});

test('a queued genuine message wake survives a failed turn without a close reminder', async () => {
  const f = await fixture('reserved2', { wake: true });
  const { h, key, st } = f;
  try {
    h.appendSocialV2Message(key, 'fixture', '新的提问', '新的提问', false, false, 'message-2', [], '111');
    st.pendingWakeReasons = [{ reason: 'atMention', seq: st.lastUnreadSeq }];
    const promptsBefore = h.calls.prompts.length;
    await emit(f, [started(9), ended(9, malformed)]);
    assert.equal(h.calls.prompts.length, promptsBefore, 'no failure-generated reminder is sent');
    assert.ok(st.pendingWakeTimer, 'the real queued message gets its normal batching timer');
    assert.equal(st.pendingWakeReason, 'atMention');
    assert.equal(st.pendingWakeReasons.length, 0);
  } finally { await h.close(); }
});

test('a failed timer-only wake keeps a future wake source without replaying the turn', async () => {
  const f = await fixture();
  const { h, key, st } = f;
  try {
    st.wakeConfig = {
      ...st.wakeConfig, mode: 'diving', infinite: false,
      sleepUntil: new Date(Date.now() - 1000).toISOString(), noActionCount: 2,
      triggers: { atMention: false, nameMention: false, question: false, poke: false, anyMessage: false, probability: 0, keywords: [], speakerIds: [] },
    };
    h.wakeConfigMissCount.set(key, 1);
    await h.sendWakePromptV2(key, 'timeout');
    assert.equal(st.wakeConfig.sleepUntil, null, 'the wake consumes its one-shot timer');
    await emit(f, [started(17), ended(17, malformed)]);
    const wc = st.wakeConfig;
    const tr = wc.triggers;
    const messageWake = tr.atMention || tr.nameMention || tr.question || tr.poke || tr.anyMessage || tr.probability > 0 || tr.keywords.length || tr.speakerIds.length;
    const timerWake = !wc.infinite && Date.parse(wc.sleepUntil) > Date.now() && st.sleepTimer;
    assert.ok(messageWake || timerWake, 'a consumed timer must not leave the conversation permanently asleep');
    assert.equal(wc.noActionCount, 2, 'wake safety recovery must preserve the behavior count');
    assert.equal(h.wakeConfigMissCount.get(key), 1);
    assert.equal(h.calls.prompts.length, 1, 'wake safety recovery does not replay the failed turn');
    assert.equal(h.calls.sent.length, 0);
  } finally { await h.close(); }
});

test('other simulation errors remain observable and diagnostics redact credentials', async () => {
  const f = await fixture();
  try {
    const token = f.st.agentToken;
    await emit(f, [started(10), ended(10, {
      kind: 'error', error: { code: 'AUTH', message: `Authentication failed password=fixture-secret ${token}` },
    })]);
    assert.equal(f.h.calls.sent.length, 1, 'service/authentication failures must not become silent');
    assert.doesNotMatch(f.h.calls.sent[0].text, /Authentication|fixture-secret|password/);
    const diagnostic = f.logs.find((line) => line.includes('"code":"AUTH"'));
    assert.ok(diagnostic, 'the diagnostic retains the error code');
    assert.match(diagnostic, /Authentication failed/, 'local logs retain a useful sanitized cause');
    assert.doesNotMatch(diagnostic, /fixture-secret/);
    assert.ok(!diagnostic.includes(token), 'known agent tokens must not appear in diagnostics');
  } finally { await f.h.close(); }
});

test('malformed diagnostics cannot log model tool argument contents', async () => {
  const f = await fixture();
  try {
    await emit(f, [started(11), ended(11, {
      kind: 'error', error: { code: 'MALFORMED_RESPONSE', message: `${malformed.error.message}: {"messages": "private-fixture-message"}` },
    })]);
    assert.equal(f.h.calls.sent.length, 0);
    assert.ok(f.logs.some((line) => line.includes('tool input is invalid JSON')));
    assert.ok(f.logs.every((line) => !line.includes('private-fixture-message')));
  } finally { await f.h.close(); }
});

test('unrelated malformed responses remain visible in simulation', async () => {
  const f = await fixture();
  try {
    await emit(f, [started(15), ended(15, {
      kind: 'error', error: { code: 'MALFORMED_RESPONSE', message: 'Unknown response event' },
    })]);
    assert.equal(f.h.calls.sent.length, 1, 'only invalid tool input JSON is quiet');
    assert.doesNotMatch(f.h.calls.sent[0].text, /Unknown response|MALFORMED_RESPONSE/);
  } finally { await f.h.close(); }
});

test('a failed silent turn releases pending wake state and retains local diagnostics', async () => {
  const f = await fixture('reserved2', { wake: true });
  try {
    f.h.social.silentTurns.set(f.sid, [{ ts: Date.now() }]);
    f.h.wakeConfigUpdatedKeys.add(f.key);
    f.h.markReadCalledKeys.add(f.key);
    await emit(f, [started(16), ended(16, { kind: 'error', error: { code: 'SERVER', message: 'Service unavailable' } })]);
    assert.equal(f.h.calls.sent.length, 0, 'background turns stay silent');
    assert.equal(f.h.isConversationBusyV2(f.key, f.st), false);
    assert.equal(f.h.pendingWakeLeaseTimers.has(f.key), false);
    assert.equal(f.h.wakeConfigUpdatedKeys.has(f.key), false);
    assert.equal(f.h.markReadCalledKeys.has(f.key), false);
    assert.equal(f.h.social.silentTurns.has(f.sid), false);
    assert.ok(f.logs.some((line) => line.includes('"code":"SERVER"')));
  } finally { await f.h.close(); }
});

test('completed turns retain close reminders and successful send deduplication', async () => {
  const f = await fixture('reserved2', { wake: true });
  try {
    await emit(f, [started(12), ended(12, { kind: 'completed' })]);
    assert.equal(f.st.wakeConfig.noActionCount, 1);
    assert.equal(f.h.wakeConfigMissCount.get(f.key), 1);
    assert.equal(f.h.calls.prompts.length, 2, 'a completed no-action turn still gets one close reminder');
    assert.equal(f.h.calls.sent.length, 0);
  } finally { await f.h.close(); }
  const direct = await fixture('chat');
  try {
    await direct.h.sendToQQ(direct.key, '工具已经发出');
    await emit(direct, [started(13),
      { type: 'tool/call', data: { turn: 13, callId: 'send', name: 'mcp__snowluma__qq_send_message', arguments: {} } },
      { type: 'tool/result', data: { turn: 13, message: { source: { callId: 'send' }, content: [{ type: 'text', text: '{"ok":true,"sent":1}' }] } } },
      assistant(13, '工具已经发出'), ended(13, { kind: 'completed' }),
      started(14), { type: 'assistant/chunk', data: { turn: 14, text: '失败尝试的流式文本' } },
      assistant(14, '恢复后正常回复'), ended(14, { kind: 'completed' }),
    ]);
    assert.deepEqual(direct.h.calls.sent.map(({ text }) => text), ['工具已经发出', '恢复后正常回复']);
  } finally { await direct.h.close(); }
});


test('legacy partial burst still records a successful reply', async () => {
  const f = await fixture('reserved');
  try {
    f.h.cfg.socialV2.send.minSendIntervalMs = 100;
    f.h.cfg.socialV2.send.queueTtlMs = 40;
    f.h.cfg.social.burstIntervalMinMs = 100;
    f.h.cfg.social.burstIntervalMaxMs = 100;
    await emit(f, [started(20), assistant(20, 'first second third'), ended(20, { kind: 'completed' })]);
    assert.equal(f.h.calls.sent.length, 1);
    assert.ok(f.h.social.states.get(f.key).lastAiReplyAt > 0);
  } finally { await f.h.close(); }
});


for (const mode of ['chat', 'reserved', 'closed-agent']) test(`${mode} does not automatically repeat an uncertain tool attempt`, async () => {
  const f = await fixture(mode);
  try {
    await emit(f, [started(21),
      { type: 'tool/call', data: { turn: 21, callId: 'unknown', name: 'qq_send_message', arguments: {} } },
      { type: 'tool/result', data: { turn: 21, message: { source: { callId: 'unknown' }, isError: true, content: [{ type: 'text', text: '{"ok":false,"sent":0,"attempted":1,"uncertain":1,"status":"unknown"}' }] } } },
      assistant(21, 'possibly delivered'), ended(21, { kind: 'completed' })
    ]);
    assert.equal(f.h.calls.sent.length, 0);
    assert.equal(f.st.lastAiReplyAt, 0);
    assert.equal(f.h.sendToolSucceededSessions.has(f.sid), false);
    assert.equal(f.h.sendToolUncertainSessions.has(f.sid), false, 'terminal turn clears uncertainty');
    await emit(f, [started(22), assistant(22, 'later'), ended(22, { kind: 'completed' })]);
    assert.equal(f.h.calls.sent.length, 1, 'a genuine later turn remains sendable');
  } finally { await f.h.close(); }
});
