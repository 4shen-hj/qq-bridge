import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

{
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    const sid = await h.ensureSession('group:456');
    const st = h.getSocialV2State('group:456');
    st.wakeConfig.infinite = false;
    st.wakeConfig.sleepUntil = new Date(Date.now() + 60000).toISOString();
    st.unread = [];
    st.pendingWakeReasons = [null, { reason: 'atMention', seq: 1 }, { reason: 'proactiveCheck' }, { reason: 'timeout' }];
    h.trackTurnEvent(sid, { type: 'turn/start', data: { turn: 1 } });
    h.v2TurnStartAt.set(sid, Date.now());
    assert.equal(h.replayPendingWakeReasonsV2('group:456'), null);
    assert.equal(st.pendingWakeReasons.length, 4, 'busy replay leaves the queue intact');
    h.trackTurnEvent(sid, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    h.v2TurnStartAt.delete(sid);
    assert.equal(h.replayPendingWakeReasonsV2('group:456').reason, 'timeout');
    assert.equal(st.pendingWakeReasons.length, 0);
    assert.ok(st.sleepTimer, 'valid timeout scheduled after stale entries');
  } finally { await h.close(); }
}
console.log('PASS stale wake queue draining and busy guard');
