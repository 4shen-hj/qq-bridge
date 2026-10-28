import fs from 'node:fs';
import path from 'node:path';

export function createOutboundScheduler({ historyFile, legacyFile, policy, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const queues = new Map();
  let history = [];
  let active = false;
  let timer;
  let lastKey;
  let initializationError;
  let closed = false;

  function persist() {
    fs.mkdirSync(path.dirname(historyFile), { recursive: true });
    const temp = `${historyFile}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, attempts: history }));
    fs.renameSync(temp, historyFile);
  }

  function initialize() {
    if (fs.existsSync(historyFile)) {
      const stored = JSON.parse(fs.readFileSync(historyFile, 'utf8').replace(/^\uFEFF/, ''));
      if (stored.version !== 1 || !Array.isArray(stored.attempts) || stored.attempts.some((t) => !Number.isFinite(t) || t < 0)) {
        throw new Error('账号发送记录损坏，已停止发送');
      }
      history = stored.attempts.slice().sort((a, b) => a - b);
    } else {
      const legacy = legacyFile && fs.existsSync(legacyFile) ? JSON.parse(fs.readFileSync(legacyFile, 'utf8').replace(/^\uFEFF/, '')) : {};
      history = Object.values(legacy.conversations ?? {}).flatMap((st) => Array.isArray(st.sendTimes) ? st.sendTimes : [])
        .filter((t) => Number.isFinite(t) && t >= 0 && t > now() - 3600000);
      history.sort((a, b) => a - b);
      persist();
    }
  }

  function settings() {
    const input = policy() ?? {};
    const number = (key, fallback, minimum = 0) => Number.isFinite(Number(input[key])) && input[key] != null
      ? Math.max(minimum, Math.floor(Number(input[key]))) : fallback;
    return { maxSendPerMinute: number('maxSendPerMinute', 8), maxSendPerHour: number('maxSendPerHour', 60),
      minSendIntervalMs: number('minSendIntervalMs', 1000), queueMaxMessages: number('queueMaxMessages', 100, 1),
      queueTtlMs: Math.min(120000, number('queueTtlMs', 120000, 1)) };
  }

  function readyAt() {
    const p = settings();
    const time = now();
    history = history.filter((t) => t > time - 3600000);
    let ready = (history.at(-1) ?? -Infinity) + p.minSendIntervalMs;
    for (const [limit, window] of [[p.maxSendPerMinute, 60000], [p.maxSendPerHour, 3600000]]) {
      const recent = history.filter((t) => t > time - window);
      if (limit > 0 && recent.length >= limit) ready = Math.max(ready, recent[recent.length - limit] + window);
    }
    return ready;
  }

  function outcome(job, reason = null) {
    return { status: job.results.length === job.items.length ? 'sent' : job.results.length ? 'partial' : job.attempted ? 'unknown' : 'not-sent',
      sent: job.results.length, sentIndices: job.results.map((r) => r.index), results: job.results, attempted: job.attempted,
      unsent: job.items.length - job.attempted, uncertain: job.attempted - job.results.length, reason, retryAfterMs: reason ? Math.max(0, readyAt() - now()) : 0 };
  }

  function finish(job, reason, error) {
    if (job.done) return;
    job.done = true;
    job.signal?.removeEventListener('abort', job.abort);
    const queue = queues.get(job.key);
    queue.splice(queue.indexOf(job), 1);
    if (!queue.length) queues.delete(job.key);
    const result = outcome(job, reason);
    if (error) { error.outbound = result; job.reject(error); }
    else job.resolve(result);
  }

  function wake() {
    clearTimer(timer);
    if (!closed) timer = setTimer(() => { void pump(); }, 0);
  }

  function watchDeadlines() {
    const waiting = [...queues.values()].flat().filter((job) => !job.inFlight);
    if (waiting.length) timer = setTimer(() => { void pump(); }, Math.max(1, Math.min(...waiting.map((j) => j.deadline)) - now()));
  }

  async function pump() {
    clearTimer(timer);
    for (const queue of [...queues.values()]) for (const job of [...queue]) {
      if (!job.inFlight && (job.signal?.aborted || now() >= job.deadline)) finish(job, job.signal?.aborted ? 'cancelled' : 'expired');
    }
    if (!queues.size) return;
    if (active) { watchDeadlines(); return; }
    const keys = [...queues.keys()];
    const previous = keys.indexOf(lastKey);
    const ordered = previous < 0 ? keys : [...keys.slice(previous + 1), ...keys.slice(0, previous + 1)];
    const available = Math.max(now(), readyAt());
    const job = ordered.map((key) => queues.get(key)[0]).find((j) => j.ready <= now() && available <= now());
    if (!job) {
      const next = Math.min(...[...queues.values()].flatMap((q) => q.map((j, i) => i ? j.deadline : Math.min(j.deadline, Math.max(j.ready, available)))));
      timer = setTimer(() => { void pump(); }, Math.max(1, next - now()));
      return;
    }
    active = true;
    job.inFlight = true;
    lastKey = job.key;
    watchDeadlines();
    try {
      job.assertAllowed?.();
      history.push(now());
      persist();
      const index = job.attempted++;
      const value = await job.items[index].transport();
      job.results.push({ index, value });
      job.ready = now() + Math.max(0, job.items[index].delayAfterMs ?? 0);
      if (job.results.length === job.items.length) finish(job);
      else if (closed) finish(job, 'cancelled');
    } catch (error) {
      finish(job, 'error', error);
    } finally {
      job.inFlight = false;
      active = false;
      wake();
    }
  }

  try { initialize(); } catch (error) { initializationError = error; }

  return {
    close() {
      closed = true;
      clearTimer(timer);
      for (const queue of [...queues.values()]) for (const job of [...queue]) if (!job.inFlight) finish(job, 'cancelled');
    },
    send({ key, items, assertAllowed, signal }) {
      if (initializationError) return Promise.reject(initializationError);
      if (closed) return Promise.resolve(outcome({ items, results: [], attempted: 0 }, 'cancelled'));
      const p = settings();
      const pending = [...queues.values()].flat().reduce((n, j) => n + j.items.length - j.attempted, 0);
      const base = { items, results: [], attempted: 0 };
      if (signal?.aborted) return Promise.resolve(outcome(base, 'cancelled'));
      if (pending + items.length > p.queueMaxMessages) return Promise.resolve(outcome(base, 'queue-full'));
      if (!items.length) return Promise.resolve(outcome(base));
      return new Promise((resolve, reject) => {
        const job = { ...base, key, assertAllowed, signal, resolve, reject, ready: now(), deadline: now() + p.queueTtlMs };
        job.abort = wake;
        signal?.addEventListener('abort', job.abort, { once: true });
        if (!queues.has(key)) queues.set(key, []);
        queues.get(key).push(job);
        wake();
      });
    },
  };
}

function sendResultMatches(value, matches) {
  if (typeof value === 'string') { try { return sendResultMatches(JSON.parse(value), matches); } catch { return false; } }
  if (!value || typeof value !== 'object') return false;
  if (typeof value.sent === 'number') return matches(value);
  if (value.outbound) return sendResultMatches(value.outbound, matches);
  if (value.structuredContent) return sendResultMatches(value.structuredContent, matches);
  if (Array.isArray(value.content)) return value.content.some((part) => sendResultMatches(part, matches));
  for (const key of ['text', 'result', 'value', 'data', 'message']) if (value[key] && sendResultMatches(value[key], matches)) return true;
  return false;
}

export function sendResultSucceeded(value) {
  return sendResultMatches(value, (result) => result.sent > 0);
}

export function sendResultUncertain(value) {
  return sendResultMatches(value, (result) => result.uncertain > 0 || result.status === 'unknown');
}
