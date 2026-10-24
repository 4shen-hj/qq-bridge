// Request IDs correlate receipts; they do not imply server-side deduplication.
export function createPromptDelivery(store, persist = () => {}) {
  for (const s of Object.values(store)) {
    for (const r of Object.values(s.requests ?? {})) if (r.status === 'submitting') r.status = 'uncertain';
  }
  const session = (sid) => store[sid] ??= { initialized: false, through: -1, turns: {}, requests: {} };
  const eventOf = (entry) => entry?.type === 'event' ? entry.event : entry;
  function request(sid, id, status, options = {}) {
    const s = session(sid);
    const previous = s.requests[id];
    // A stream receipt can arrive before the unary response fails.
    if (['observed', 'handled'].includes(previous?.status)) return previous;
    s.requests[id] = { ...previous, status, silent: !!options.silent, farewell: !!options.farewell };
    persist();
    return s.requests[id];
  }
  function observe(sid, event, fallbackTurn) {
    const s = session(sid);
    const message = event?.data?.message;
    const source = message?.source ?? event?.data?.source;
    const id = source?.requestId ?? source?.rpcId ?? message?.requestId ?? event?.data?.requestId;
    const receipt = id && s.requests[id];
    if (!receipt || receipt.status === 'handled') return;
    receipt.status = 'observed';
    const turn = event.data?.turn ?? (fallbackTurn === null ? undefined : fallbackTurn ?? s.activeTurn);
    if (Number.isInteger(turn)) {
      receipt.turn = turn;
      s.turns[turn] = { ...s.turns[turn], silent: receipt.silent, farewell: receipt.farewell };
    }
    persist();
    return true;
  }
  return {
    request,
    status: (sid, id) => session(sid).requests[id]?.status,
    uncertain: (sid) => Object.values(session(sid).requests).some((r) => r.status === 'uncertain'),
    observe,
    start(sid, turn) {
      const s = session(sid);
      if (!Number.isInteger(turn) || (turn <= s.through && !s.turns[turn])) return false;
      s.turns[turn] ??= {};
      s.activeTurn = turn;
      persist();
      return true;
    },
    finish(sid, turn) {
      const s = session(sid);
      const receipt = s.turns[turn];
      if (!receipt) return null;
      delete s.turns[turn];
      if (s.activeTurn === turn) delete s.activeTurn;
      s.through = Math.max(s.through, turn);
      for (const r of Object.values(s.requests)) if (r.turn === turn) r.status = 'handled';
      persist();
      return receipt;
    },
    snapshot(sid, snapshot) {
      const s = session(sid);
      const events = (snapshot.records ?? []).map(eventOf).filter(Boolean);
      let turn;
      const open = new Set();
      for (const event of events) {
        if (event.type === 'turn/start') { turn = event.data?.turn; open.add(turn); }
        observe(sid, event, turn);
        if (event.type === 'turn/end') { open.delete(event.data?.turn); turn = undefined; }
      }
      for (const list of Object.values(snapshot.projections?.values?.inbox ?? {})) {
        if (Array.isArray(list)) for (const message of list) observe(sid, { data: { message } }, null);
      }
      for (const event of events) {
        const t = event.data?.turn;
        if (!Number.isInteger(t)) continue;
        if (open.has(t) || (s.initialized && t > s.through)) s.turns[t] ??= {};
      }
      if (!s.initialized) {
        s.through = Math.max(s.through, ...events.filter((e) => e.type === 'turn/end').map((e) => Number(e.data?.turn)).filter(Number.isFinite));
        s.initialized = true;
      }
      persist();
      turn = undefined;
      return events.filter((event) => {
        if (event.type === 'turn/start') turn = event.data?.turn;
        const t = event.data?.turn ?? turn;
        const include = Number.isInteger(t) && !!s.turns[t];
        if (event.type === 'turn/end') turn = undefined;
        return include;
      });
    },
  };
}
