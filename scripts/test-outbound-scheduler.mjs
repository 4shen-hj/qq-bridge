import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOutboundScheduler, sendResultSucceeded } from '../src/outbound-scheduler.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-outbound-'));
let sequence = 0;
function fixture(options = {}, files = {}) {
  const dir = path.join(root, String(sequence++));
  fs.mkdirSync(dir);
  for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
  let time = 4000000;
  const timers = new Map();
  let timerId = 0;
  const policy = { minSendIntervalMs: 1000, queueTtlMs: 120000, queueMaxMessages: 100, ...options };
  const historyFile = path.join(dir, 'history.json');
  const args = { historyFile, legacyFile: path.join(dir, 'legacy.json'), policy: () => policy,
    now: () => time, setTimer: (fn, ms) => { timers.set(++timerId, { fn, at: time + ms }); return timerId; }, clearTimer: (id) => timers.delete(id) };
  let scheduler = createOutboundScheduler(args);
  const calls = [];
  const item = (label, delayAfterMs = 0, fail = false) => ({ delayAfterMs, transport: async () => {
    const stored = JSON.parse(fs.readFileSync(historyFile));
    assert.equal(stored.attempts.at(-1), time, 'attempt persisted before transport');
    calls.push([label, time]);
    if (fail) throw new Error('gateway unknown');
    return label;
  } });
  return { dir, historyFile, calls, policy, item, get scheduler() { return scheduler; },
    restart() { scheduler.close(); scheduler = createOutboundScheduler(args); },
    async advance(ms = 0) {
      const end = time + ms;
      for (let count = 0; count < 10000; count++) {
        await new Promise(setImmediate);
        const entry = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) { time = end; return; }
        timers.delete(entry[0]); time = entry[1].at; entry[1].fn();
      }
      assert.fail('timer loop did not converge');
    }
  };
}

try {
  const f = fixture();
  const a = f.scheduler.send({ key: 'a', items: [f.item('a1', 5000), f.item('a2')] });
  const b = f.scheduler.send({ key: 'b', items: [f.item('b1'), f.item('b2')] });
  const aNext = f.scheduler.send({ key: 'a', items: [f.item('a3')] });
  await f.advance(6000);
  assert.deepEqual(f.calls, [['a1', 4000000], ['b1', 4001000], ['b2', 4002000], ['a2', 4005000], ['a3', 4006000]]);
  assert.deepEqual((await a).results.map((r) => r.index), [0, 1]);
  await Promise.all([b, aNext]); f.scheduler.close();

  const quota = fixture({ maxSendPerMinute: 2, maxSendPerHour: 3 });
  const pending = quota.scheduler.send({ key: 'a', items: [1, 2, 3, 4].map((n) => quota.item(n)) });
  await quota.advance(120000);
  const partial = await pending;
  assert.equal(partial.sent, 3); assert.equal(partial.reason, 'expired'); assert.equal(partial.unsent, 1);
  assert.deepEqual(quota.calls.map((c) => c[1]), [4000000, 4001000, 4060000]);
  await quota.advance(3600000); assert.equal(quota.calls.length, 3, 'expiry discards remaining work'); quota.scheduler.close();

  const cancel = fixture({ queueMaxMessages: 2 });
  const controller = new AbortController();
  const first = cancel.scheduler.send({ key: 'a', items: [cancel.item(1), cancel.item(2)], signal: controller.signal });
  assert.equal((await cancel.scheduler.send({ key: 'b', items: [cancel.item(3)] })).reason, 'queue-full');
  await cancel.advance(); controller.abort(); await cancel.advance(10000);
  assert.equal((await first).sent, 1); assert.equal(cancel.calls.length, 1); cancel.scheduler.close();

  const failure = fixture({ maxSendPerMinute: 1, queueTtlMs: 100 });
  const failed = failure.scheduler.send({ key: 'a', items: [failure.item('bad', 0, true), failure.item('never')] }).catch((e) => e);
  await failure.advance();
  const error = await failed;
  assert.equal(error.outbound.attempted, 1); assert.equal(error.outbound.uncertain, 1); assert.equal(error.outbound.unsent, 1);
  failure.restart();
  const afterRestart = failure.scheduler.send({ key: 'b', items: [failure.item('retry')] });
  await failure.advance(100); assert.equal((await afterRestart).reason, 'expired'); assert.equal(failure.calls.length, 1); failure.scheduler.close();

  const migrate = fixture({ maxSendPerMinute: 2, queueTtlMs: 20 }, { 'legacy.json': { conversations: { a: { sendTimes: [3999999] }, b: { sendTimes: [3999999] } } } });
  assert.deepEqual(JSON.parse(fs.readFileSync(migrate.historyFile)).attempts, [3999999, 3999999]);
  fs.writeFileSync(path.join(migrate.dir, 'legacy.json'), JSON.stringify({ conversations: { a: { sendTimes: [3999998, 3999997] } } }));
  migrate.restart(); assert.equal(JSON.parse(fs.readFileSync(migrate.historyFile)).attempts.length, 2);
  const denied = migrate.scheduler.send({ key: 'a', items: [migrate.item('blocked')] }); await migrate.advance(20); assert.equal((await denied).sent, 0); migrate.scheduler.close();

  const bom = fixture({}, { 'legacy.json': '\uFEFF' + JSON.stringify({ conversations: { a: { sendTimes: [3999999] } } }) });
  assert.equal(JSON.parse(fs.readFileSync(bom.historyFile)).attempts.length, 1);
  fs.writeFileSync(bom.historyFile, '\uFEFF' + fs.readFileSync(bom.historyFile, 'utf8'));
  bom.restart();
  const bomSend = bom.scheduler.send({ key: 'a', items: [{ transport: async () => 'ok' }] });
  await bom.advance(1000); assert.equal((await bomSend).sent, 1); bom.scheduler.close();

  const empty = fixture(); empty.restart(); assert.deepEqual(JSON.parse(fs.readFileSync(empty.historyFile)).attempts, []); empty.scheduler.close();
  const corrupt = fixture({}, { 'history.json': { attempts: 'broken' } });
  await assert.rejects(corrupt.scheduler.send({ key: 'a', items: [corrupt.item('no')] }), /损坏/); corrupt.scheduler.close();
  const disk = fixture(); fs.mkdirSync(`${disk.historyFile}.tmp`);
  const diskFail = disk.scheduler.send({ key: 'a', items: [disk.item('no')] }).catch((e) => e); await disk.advance();
  assert.ok((await diskFail) instanceof Error); assert.equal(disk.calls.length, 0); disk.scheduler.close();
  const guard = fixture();
  const rejected = guard.scheduler.send({ key: 'a', items: [guard.item('no')], assertAllowed() { throw new Error('revoked'); } }).catch((e) => e);
  await guard.advance(); assert.equal((await rejected).message, 'revoked'); assert.equal(JSON.parse(fs.readFileSync(guard.historyFile)).attempts.length, 0); guard.scheduler.close();

  const held = fixture({ queueTtlMs: 50 });
  let release;
  const inFlight = held.scheduler.send({ key: 'a', items: [{ transport: () => new Promise((resolve) => { release = resolve; }) }, held.item('never')] });
  const expires = held.scheduler.send({ key: 'b', items: [held.item('expired')] });
  await held.advance(50);
  assert.equal((await expires).reason, 'expired', 'other deadlines settle during an active transport');
  held.scheduler.close(); release('first');
  const closed = await inFlight;
  assert.equal(closed.sent, 1); assert.equal(closed.reason, 'cancelled'); assert.equal(closed.unsent, 1);
  assert.equal(held.calls.length, 0, 'shutdown does not dispatch remainder');

  assert.equal(sendResultSucceeded({ content: [{ text: '{"ok":true,"sent":0,"reason":"expired"}' }] }), false);
  assert.equal(sendResultSucceeded({ isError: true, content: [{ text: '{"ok":false,"sent":1}' }] }), true);
  assert.equal(sendResultSucceeded({ content: [{ type: 'tool-result', result: { content: [{ text: '{"sent":1}' }] } }] }), true);
  console.log('PASS account scheduler fairness, spacing, limits, cancellation, persistence and truthful outcomes');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
