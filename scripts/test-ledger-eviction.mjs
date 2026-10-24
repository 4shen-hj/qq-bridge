import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTokenLedger } from '../src/token-ledger.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ledger-eviction-'));
const at = Date.parse('2026-03-02T20:00:00+08:00');
const event = (seq, inputTokens = 10) => ({
  seq, time: at + seq, type: 'assistant/message',
  data: { turn: seq, step: 1, usage: { inputTokens } },
});
const baseline = (ledger, seq, inputTokens) => ledger.ingestBaseline({
  sessionId: 's', at,
  projection: { asOfSeq: seq, values: { tokenUsage: { inputTokens } } },
});
const ingest = (ledger, seq, tokens = 10) => ledger.ingestEvent({ sessionId: 's', event: event(seq, tokens) });
const check = (ledger, tokens) => {
  assert.equal(ledger.summary().totals.totalTokens, tokens);
  const series = ledger.series({ at: at + 1000 });
  assert.equal(series.totals.tokens + series.offChartTokens, tokens);
  const totalCost = ledger.summary().totals.cost;
  assert.ok(Math.abs(series.totals.cost + series.offChartCost - totalCost) < 1e-12);
};
try {
  const file = path.join(temp, 'usage.jsonl');
  const open = () => createTokenLedger({ file, maxLines: 2, resolveKey: () => 'group:456', now: () => at });
  let ledger = open();
  baseline(ledger, 10, 100);
  ingest(ledger, 1, 100);
  for (const seq of [11, 12, 13]) ingest(ledger, seq);
  check(ledger, 130);
  assert.equal(ledger.compact(), true, 'fixture compaction must succeed');
  ledger = open();
  check(ledger, 130);
  assert.equal(ingest(ledger, 11), false, 'replayed evicted increment is not counted again');
  check(ledger, 130);
  for (const seq of [14, 15, 16]) ingest(ledger, seq);
  check(ledger, 160);
  baseline(ledger, 12, 120);
  check(ledger, 160);
  assert.equal(ledger.compact(), true);
  ledger = open();
  check(ledger, 160);
  baseline(ledger, 14, 140);
  check(ledger, 160);
  ingest(ledger, 13);
  check(ledger, 160);
  baseline(ledger, 16, 160);
  check(ledger, 160);
  baseline(ledger, 12, 120);
  check(ledger, 160);
  ingest(ledger, 17);
  check(ledger, 170);
  ledger = open();
  check(ledger, 170);
  assert.ok(ledger.stats().samples <= 2);

  ledger.reset();
  for (const seq of [1, 2, 3, 4, 5]) ingest(ledger, seq);
  check(ledger, 50);
  ledger = open();
  assert.equal(ingest(ledger, 1), false);
  check(ledger, 50);
  baseline(ledger, 2, 20);
  check(ledger, 50);
  baseline(ledger, 5, 50);
  check(ledger, 50);
  ledger = open();
  check(ledger, 50);
  assert.equal(ledger.stats().pendingEvictedSamples, 0, 'baseline releases covered increment records');

  ledger.reset();
  for (const seq of [1, 2, 3]) ingest(ledger, seq);
  assert.equal(ledger.ingestEvent({ sessionId: 's', event: {
    ...event(4, 15), data: { turn: 1, step: 1, usage: { inputTokens: 15 } },
  } }), true);
  check(ledger, 35);
  ledger = open();
  check(ledger, 35);

  fs.writeFileSync(file, JSON.stringify({
    k: 'evict', sid: 's', key: 'group:456', maxSeq: 12, dropped: 2,
    b: { inputTokens: 110 }, cost: 0.00011, peak: 0, off: 0.00011,
  }) + '\n');
  ledger = open();
  baseline(ledger, 10, 100);
  assert.equal(ledger.summary().usageIncomplete, true, 'legacy mixed buckets cannot be split without original samples');
  assert.equal(ledger.series({ at }).usageIncomplete, true);
  baseline(ledger, 12, 120);
  check(ledger, 120);
  assert.equal(ledger.summary().usageIncomplete, false, 'authoritative baseline resolves legacy uncertainty');
  ledger = open();
  check(ledger, 120);
  console.log('PASS ledger eviction, moving baselines, reload and replay');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
