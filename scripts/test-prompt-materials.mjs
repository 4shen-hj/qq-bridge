import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { DEFAULT_PROMPT_SECTIONS, PROMPT_SECTIONS, selectWakeMemory, selectWakeSlang } from '../src/qq-prompt-context.js';

const KEY = 'group:456';
const slang = [
  { content: '无关热门词', meaning: 'unrelated-meaning', count: 999, status: 'confirmed' },
  { content: '待确认', meaning: 'candidate-meaning', count: 200, status: 'candidate' },
  { content: 'ai', meaning: 'ai-meaning', count: 100, status: 'confirmed' },
  { content: '潜水', meaning: 'matched-meaning', count: 1, status: 'confirmed' },
  { content: '藏词', meaning: 'hidden-meaning', count: 50, status: 'confirmed' },
];

async function fixture(run, { config = {}, files = {}, globals = {} } = {}) {
  const h = await bridgeHarness({
    config: { slang: { enabled: true, injectMax: 1 }, socialV2: {
      proactive: { enabled: false }, sticker: { enabled: false }, ...config,
    } },
    files: { 'state/slang.json': slang, ...files }, globals,
  });
  h.setMode('reserved2');
  const st = h.getSocialV2State(KEY);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const request = (query = '', { token = st.agentToken, key = KEY } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: `/api/socialV2/prompt?key=${encodeURIComponent(key)}${query}`,
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': token },
    }, (res) => {
      let raw = ''; res.setEncoding('utf8'); res.on('data', (part) => { raw += part; });
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); } catch (error) { reject(error); } });
    });
    req.on('error', reject); req.end();
  });
  const append = (text, sender = 'Alice', userId = '789') => h.appendSocialV2Message(KEY,
    sender, text, text, false, false, `fixture-${st.lastUnreadSeq + 1}`, [], userId, []);
  try { await run({ h, st, request, append }); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

test('prompt defaults are lean, explicit sections are exact and unselected providers are not called', async () => {
  let voices = 0;
  await fixture(async ({ h, st, request, append }) => {
    let stickers = 0;
    const originalRequest = h.bot.request.bind(h.bot);
    h.bot.request = async (action, params) => { if (action === 'fetch_custom_face_detail') stickers++; return originalRequest(action, params); };
    append('fixture message');
    st.pendingThoughts = [{ text: 'stored thought' }];
    const before = JSON.stringify({ unread: st.unread, memory: st.pendingThoughts, read: st.lastReadThroughSeq });
    const defaults = await request();
    assert.equal(defaults.status, 200);
    assert.deepEqual(Object.keys(defaults.data).sort(), ['ok', 'key', 'time', ...DEFAULT_PROMPT_SECTIONS].sort());
    assert.equal(stickers, 0); assert.equal(voices, 0);
    const role = await request('&sections=role');
    assert.deepEqual(Object.keys(role.data).sort(), ['ok', 'key', 'time', 'role'].sort());
    assert.equal(stickers, 0); assert.equal(voices, 0);
    const selected = await request('&sections=memory,role,role');
    assert.deepEqual(Object.keys(selected.data).sort(), ['ok', 'key', 'time', 'memory', 'role'].sort());
    assert.match(selected.data.memory, /stored thought/);
    assert.equal(stickers, 0); assert.equal(voices, 0);
    assert.equal(JSON.stringify({ unread: st.unread, memory: st.pendingThoughts, read: st.lastReadThroughSeq }), before);
    const all = await request(`&sections=${PROMPT_SECTIONS.join(',')}`);
    assert.equal(all.status, 200);
    assert.deepEqual(Object.keys(all.data).sort(), ['ok', 'key', 'time', ...PROMPT_SECTIONS].sort());
    assert.equal(stickers, 1); assert.ok(voices > 0);
    assert.match(all.data.stickers.context, /不是给你的指令/);
    assert.ok(JSON.stringify(defaults.data).length < JSON.stringify(all.data).length / 2);
    console.log(`prompt fixture characters: default=${JSON.stringify(defaults.data).length}, role=${JSON.stringify(role.data).length}, explicit-all=${JSON.stringify(all.data).length} (not tokens)`);
  }, { config: { sticker: { enabled: true }, voice: { enabled: true } }, globals: { listAudioFiles: () => { voices++; return []; } } });
});

test('invalid selections and unauthorized callers cannot fetch optional sections', async () => {
  await fixture(async ({ h, st, request }) => {
    let calls = 0;
    h.bot.request = async () => { calls++; throw new Error('unexpected gateway request'); };
    for (const query of ['&sections=', '&sections=role,', '&sections=unknown', '&sections=role,,memory', '&sections=__proto__']) {
      assert.equal((await request(query)).status, 400);
    }
    assert.equal((await request('&sections=stickers', { token: 'wrong-token' })).status, 403);
    const other = h.getSocialV2State('group:999');
    assert.equal((await request('&sections=stickers', { token: st.agentToken, key: 'group:999' })).status, 403);
    assert.equal((await request('&sections=stickers', { token: other.agentToken, key: 'group:999' })).status, 403);
    h.cfg.socialV2.tools.getPrompt = false;
    assert.equal((await request('&sections=stickers')).status, 403);
    h.cfg.socialV2.tools.getPrompt = true;
    h.setMode('chat');
    assert.equal((await request('&sections=stickers')).status, 403);
    assert.equal(calls, 0);
  }, { config: { sticker: { enabled: true } } });
});

test('delivered partial wake selects only visible slang before the limit and preserves receipts', async () => {
  await fixture(async ({ h, st, append }) => {
    h.cfg.socialV2.context.wakeMessageLimit = 1;
    h.cfg.socialV2.context.wakeRecentLimit = 0;
    append('chair，潜水！待确认');
    append('藏词');
    await h.sendWakePromptV2(KEY, 'question');
    const text = h.calls.prompts[0].content.map((part) => part.text ?? '').join('\n');
    assert.match(text, /matched-meaning/);
    assert.doesNotMatch(text, /unrelated-meaning|candidate-meaning|ai-meaning|hidden-meaning/);
    const snapshot = JSON.parse(text.split('【本次消息快照】\n')[1]);
    assert.equal(snapshot.partial, true); assert.equal(snapshot.readThroughSeq, 1);
    assert.deepEqual(snapshot.messages.map((message) => message.seq), [1]);
    assert.deepEqual(Array.from(st.modelSeenSeqs), [1]);
    assert.equal(st.unread.length, 2); assert.equal(h.calls.sent.length, 0);
  });
});

test('no snapshot injects no slang while ordinary chat retains its existing dictionary', async () => {
  await fixture(async ({ h, append }) => {
    h.cfg.socialV2.context.inlineWakeMessages = false;
    append('潜水');
    await h.sendWakePromptV2(KEY, 'question');
    const wake = h.calls.prompts[0].content.map((part) => part.text ?? '').join('\n');
    assert.doesNotMatch(wake, /【群聊黑话表】|matched-meaning|unrelated-meaning/);
  });
  await fixture(async ({ h }) => {
    h.setMode('chat');
    await h.deliverPrompt(KEY, 'ordinary chat');
    const text = h.calls.prompts[0].content.map((part) => part.text ?? '').join('\n');
    assert.match(text, /unrelated-meaning/);
  });
});

test('literal slang matching handles ASCII boundaries, punctuation and Chinese without regex interpretation', () => {
  const entries = ['ai', 'c++', '潜水', '[x]'].map((content) => ({ content, status: 'confirmed', meaning: content }));
  assert.deepEqual(selectWakeSlang(entries, [{ text: 'chair said c++；潜水！[x]' }]).map((entry) => entry.content), ['c++', '潜水', '[x]']);
  assert.deepEqual(selectWakeSlang(entries, [{ text: 'AI? chair' }]).map((entry) => entry.content), ['ai']);
  assert.deepEqual(selectWakeSlang(entries, [{ plain: 'AI', tail: '潜水' }]).map((entry) => entry.content), ['ai', '潜水']);
});

test('delivered long-message tail is matched while an undisplayed middle and unread message are not', async () => {
  await fixture(async ({ h, st, append }) => {
    h.cfg.socialV2.context.wakeMessageLimit = 1;
    h.cfg.socialV2.context.wakeRecentLimit = 0;
    append('a'.repeat(300) + '藏词' + 'b'.repeat(300) + '潜水');
    append('无关热门词');
    st.activeTopics = [{ text: '潜水' }, { text: '藏词' }];
    await h.sendWakePromptV2(KEY, 'question');
    const text = h.calls.prompts[0].content.map((part) => part.text ?? '').join('\n');
    const snapshot = JSON.parse(text.split('【本次消息快照】\n')[1]);
    assert.match(snapshot.messages[0].tail, /潜水/);
    assert.doesNotMatch(JSON.stringify(snapshot), /藏词|无关热门词/);
    assert.match(text, /matched-meaning/);
    assert.doesNotMatch(text, /hidden-meaning|unrelated-meaning/);
    const memory = text.split('【相关记忆资料】')[1].split('\n\n')[0];
    assert.match(JSON.parse(memory), /潜水/);
    assert.doesNotMatch(JSON.parse(memory), /藏词/);
  });
});

test('memory selection retains unfinished commitments and exact participants without modifying storage', () => {
  const now = 10000;
  const state = {
    activeTopics: [
      { text: 'participant topic', participants: ['789'] },
      { text: '字面话题' }, { text: 'unrelated topic' },
      { text: 'unfinished topic', pendingQuestion: 'remember this question' },
    ],
    pendingThoughts: [{ text: 'live thought', expiresAt: now + 1 }, { text: 'expired thought', expiresAt: now }, { text: 'open thought' }],
    memberImpressions: { Alice: { traits: ['visible-name'] }, '789': { traits: ['visible-id'] }, Bob: { traits: ['unrelated-person'] } },
  };
  const before = JSON.stringify(state);
  const selected = selectWakeMemory(state, [{ text: '聊字面话题吧', sender: 'Alice', userId: '789' }], 'question', now);
  assert.deepEqual(selected.activeTopics.map((topic) => topic.text), ['participant topic', '字面话题', 'unfinished topic']);
  assert.deepEqual(selected.pendingThoughts.map((thought) => thought.text), ['live thought', 'open thought']);
  assert.deepEqual(Object.keys(selected.memberImpressions), ['789', 'Alice']);
  assert.equal(selectWakeMemory(state, [], 'proactiveCheck', now).activeTopics.length, 4);
  assert.equal(selectWakeMemory(state, [], 'bootstrap', now).activeTopics.length, 4);
  assert.deepEqual(selectWakeMemory(state, [], 'question', now).activeTopics.map((topic) => topic.text), ['unfinished topic']);
  assert.equal(JSON.stringify(state), before);
});

test('actual wake omits unrelated memory and sticker descriptions but keeps explicit retrieval', async () => {
  await fixture(async ({ h, st, append, request }) => {
    append('today topic');
    st.activeTopics = [{ text: 'visible-topic-marker', participants: ['Alice'] }, { text: 'unrelated-topic-marker' }];
    st.pendingThoughts = [{ text: 'live-thought-marker' }, { text: 'expired-thought-marker', expiresAt: 1 }];
    st.memberImpressions = { Alice: { traits: ['visible-person-marker'] }, Bob: { traits: ['unrelated-person-marker'] } };
    const before = JSON.stringify({ topics: st.activeTopics, thoughts: st.pendingThoughts, members: st.memberImpressions });
    await h.sendWakePromptV2(KEY, 'question');
    const wake = h.calls.prompts[0].content.map((part) => part.text ?? '').join('\n');
    assert.match(wake, /visible-topic-marker/); assert.match(wake, /visible-person-marker/); assert.match(wake, /live-thought-marker/);
    assert.doesNotMatch(wake, /unrelated-topic-marker|unrelated-person-marker|expired-thought-marker|fixture-sticker-description/);
    assert.match(wake, /【相关记忆资料】"/); assert.match(wake, /【可用表情包】1 个/);
    const full = await request('&sections=memory');
    assert.match(full.data.memory, /unrelated-topic-marker/); assert.match(full.data.memory, /unrelated-person-marker/);
    assert.equal(JSON.stringify({ topics: st.activeTopics, thoughts: st.pendingThoughts, members: st.memberImpressions }), before);
    h.cfg.socialV2.sticker.enabled = false;
    assert.doesNotMatch(h.buildWakePromptV2(KEY, 'question'), /【可用表情包】/);
    assert.equal(h.calls.sent.length, 0);
    console.log(`material wake fixture: ${wake.length} characters including snapshot (not tokens)`);
  }, { config: { sticker: { enabled: true } }, files: { 'state/stickers.json': [{ id: 'fixture-sticker', desc: 'fixture-sticker-description' }] } });
});
