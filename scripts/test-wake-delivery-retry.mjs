import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { setImmediate as immediate } from 'node:timers/promises';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let now = Date.parse('2026-10-23T10:00:00Z');
const timers = new Set();
class ClockDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
const clock = {
  Date: ClockDate,
  setTimeout(fn, delay) {
    const timer = { fn, at: now + Math.max(0, Number(delay) || 0), unref() {} };
    timers.add(timer);
    return timer;
  },
  clearTimeout(timer) { timers.delete(timer); },
};
async function settle() { for (let i = 0; i < 4; i++) await immediate(); }
async function advance(ms) {
  const end = now + ms;
  for (;;) {
    const next = [...timers].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
    if (!next) break;
    timers.delete(next);
    now = next.at;
    next.fn();
    await settle();
  }
  now = end;
  await settle();
}

let handler;
const h = await bridgeHarness({
  config: { sendDelayMs: 0, socialV2: { proactive: { enabled: false }, wake: { maxWakePerMinute: 0, maxWakePerHour: 0 } } },
  globals: { ...clock, http: { createServer(fn) {
    handler = fn;
    return { listen(_port, _host, ready) { ready(); }, on() {}, address() { return { port: 3100 }; } };
  } } },
});
const key = 'group:456';
async function request(url, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method: 'POST', url, headers: { host: '127.0.0.1:3100', 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' } });
  const result = {};
  await handler(req, { writeHead(status) { result.status = status; }, end(raw) { result.body = JSON.parse(raw); } });
  return result;
}
try {
  h.setMode('reserved2');
  h.startConsoleServer();
  await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  const deadline = new ClockDate(now - 1000).toISOString();
  st.wakeConfig.infinite = false;
  st.wakeConfig.sleepUntil = deadline;
  let attempts = 0;
  const attemptTimes = [];
  h.api.sessions.prompt = async (params) => {
    attempts++;
    attemptTimes.push(now);
    if (attempts <= 9) throw new Error('fixture transient failure');
    h.calls.prompts.push(params);
    return { result: { ok: true, value: {} } };
  };
  await h.sendWakePromptV2(key, 'admin');
  await settle();
  assert.equal(attempts, 1, 'failed expired sleep must yield before retrying');
  assert.equal(st.wakeConfig.sleepUntil, deadline, 'original sleep deadline is retained');
  assert.equal(st.wakeRetry.reason, 'admin', 'retry retains the original wake reason');
  h.setupSleepTimerV2(key);
  await h.sendWakePromptV2(key, 'timeout');
  assert.equal(attempts, 1, 'the original deadline and another trigger cannot bypass backoff');
  for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]) {
    const before = attempts;
    await advance(delay - 1);
    assert.equal(attempts, before, 'no delivery before retry deadline');
    await advance(1);
    assert.equal(attempts, before + 1, 'one delivery at each retry deadline');
  }
  assert.equal(attempts, 10);
  assert.equal(st.wakeRetry, null, 'success clears retry state');
  assert.equal(st.lastWakeReason, 'admin');
  assert.equal(st.wakeConfig.sleepUntil, null);
  assert.equal(h.calls.prompts.length, 1);
  console.log('PASS expired sleep retries once per backoff, capped at 60000 ms, preserving admin reason');

  h.pendingWakeKeys.delete(key);
  st.wakeConfig.sleepUntil = new ClockDate(now - 1000).toISOString();
  let rejectedAttempts = 0;
  h.api.sessions.prompt = async () => {
    rejectedAttempts++;
    return rejectedAttempts === 1
      ? { result: { ok: false, error: { code: 'UNAVAILABLE', message: 'fixture rejection' } } }
      : { result: { ok: true, value: {} } };
  };
  const rejected = h.sendWakePromptV2(key, 'timeout');
  await settle();
  await advance(0);
  await rejected;
  assert.ok(st.wakeRetry?.timer, 'explicit DSH rejection also schedules backoff');
  h.pendingWakeKeys.add(key);
  await advance(1000);
  assert.equal(rejectedAttempts, 1, 'a busy conversation defers the due retry');
  h.pendingWakeKeys.delete(key);
  h.replayPendingWakeReasonsV2(key);
  await settle();
  assert.equal(rejectedAttempts, 2, 'turn completion resumes the deferred timeout retry');
  assert.equal(st.wakeRetry, null);
  console.log('PASS explicit rejection uses backoff and a busy retry resumes after the turn');

  for (const phase of ['scheduled', 'inflight']) {
    for (const cancel of ['new-config', 'default-config', 'wake-safety', 'reset', 'mode', 'pause']) {
      h.setMode('reserved2');
      h.socialV2.paused = false;
      await h.ensureSession(key);
      const active = h.getSocialV2State(key);
      active.wakeConfig.infinite = false;
      active.wakeConfig.sleepUntil = new ClockDate(now - 1000).toISOString();
      if (cancel === 'default-config') active.wakeConfig.confirmedBy = 'default';
      if (cancel === 'wake-safety') {
        active.wakeConfig.mode = 'diving';
        active.wakeConfig.triggers = {};
        h.cfg.socialV2.wake.preSleepWaitEnabled = false;
      }
      h.pendingWakeKeys.delete(key);
      h.collectors.clear();
      h.v2TurnStartAt.clear();
      let release;
      let began;
      const started = new Promise((resolve) => { began = resolve; });
      const gate = new Promise((resolve) => { release = resolve; });
      h.api.sessions.prompt = async () => { attempts++; began(); if (phase === 'inflight') await gate; throw new Error('fixture late failure'); };
      const sending = h.sendWakePromptV2(key, 'timeout');
      await started;
      if (phase === 'scheduled') {
        await sending;
        assert.ok(active.wakeRetry?.timer, 'retry timer is scheduled before cancellation');
      }
      const response = cancel === 'new-config'
        ? await request('/api/socialV2/wake-config', { key, config: { mode: 'active' } })
        : cancel === 'default-config'
          ? await request('/api/socialV2/config', { wake: { defaultMode: 'active' } })
          : cancel === 'wake-safety'
            ? await request('/api/socialV2/mark-read', { key })
            : cancel === 'reset'
          ? await request('/api/session/reset', { key })
          : cancel === 'mode'
            ? await request('/api/mode', { mode: 'chat' })
            : await request('/api/socialV2/activity', { paused: true });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      release();
      await sending;
      const before = attempts;
      await advance(65000);
      assert.equal(attempts, before, `${cancel} cancels ${phase} failure without resurrecting retry`);
      assert.equal(active.wakeRetry, null);
      if (cancel === 'new-config') assert.equal(active.wakeConfig.mode, 'active');
      console.log(`PASS ${cancel} cancels ${phase} retry`);
    }
  }
} finally {
  timers.clear();
  await h.close();
}
