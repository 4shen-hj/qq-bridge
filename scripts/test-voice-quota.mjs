import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

for (const fail of [false, true]) {
  let sends = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = await bridgeHarness({
    config: { sendDelayMs: 0, socialV2: { voice: { enabled: true, maxPerMinute: 1, maxPerHour: 1 } } },
    globals: {
      inspectAudio: async () => { await gate; return { ok: true, size: 32, duration: 1, warnings: [] }; },
      fetch: async () => {
        sends++;
        if (fail && sends === 1) throw new Error('fixture gateway failure');
        return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
      },
    },
  });
  try {
    h.setMode('reserved2');
    await h.ensureSession('group:456');
    fs.mkdirSync(path.join(h.temp, 'audio'), { recursive: true });
    fs.writeFileSync(path.join(h.temp, 'audio/fixture.mp3'), Buffer.alloc(32, 1));
    const pending = Promise.allSettled(Array.from({ length: 4 }, () => h.sendVoiceForV2('group:456', 'fixture.mp3', { verify: false })));
    release();
    const results = await pending;
    assert.equal(sends, 1);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, fail ? 0 : 1);
    assert.equal(results.filter((r) => r.status === 'rejected' && /频率超限/.test(r.reason.message)).length, 3);
    if (fail) {
      await h.sendVoiceForV2('group:456', 'fixture.mp3', { verify: false });
      assert.equal(sends, 2, 'failure releases reservation');
    }
    await assert.rejects(h.sendVoiceForV2('group:456', 'fixture.mp3', { verify: false }), /频率超限/);
  } finally { release(); await h.close(); }
}
console.log('PASS concurrent voice quota and failure release');
