// Collection discovery enriches captured source records; it never owns stream
// membership. One retained obligation survives failed/partial/stale reads.
export const DISCOVERY_DEADLINE_MS = 120000;

export function knownCapabilities(value) {
  return !!value && ["list", "read", "add", "rename"].every(key => typeof value[key] === "boolean") &&
    [false, "trash", "unlink", "hide"].includes(value.delete) &&
    typeof value.subfolders?.supported === "boolean";
}

// Partial observations may enrich unknown fields, never erase last-good fields.
export function enrichCapabilities(previous, value) {
  if (!value || typeof value !== "object") return previous ?? null;
  const next = { ...previous };
  for (const key of ["list", "read", "add", "rename"]) if (typeof value[key] === "boolean") next[key] = value[key];
  if ([false, "trash", "unlink", "hide"].includes(value.delete)) next.delete = value.delete;
  if (typeof value.subfolders?.supported === "boolean" || value.subfolders?.supported === null && !next.subfolders) {
    next.subfolders = { supported: value.subfolders.supported,
      reason: typeof value.subfolders.reason === "string" ? value.subfolders.reason : null };
  }
  return Object.keys(next).length ? next : null;
}

export function makeSourceDiscovery({ capture, read, accept, schedule = setTimeout, cancel = clearTimeout }) {
  let started = false, suspended = false, disposed = false, generation = 0;
  let flight = null, retry = null, failures = 0, requested = false;
  // Settlement must not keep a retired registry record alive.
  let settled = new WeakSet();
  const waiters = new Set();
  const active = () => started && !suspended && !disposed;
  const owns = ticket => active() && flight === ticket && generation === ticket.generation;
  const unresolved = snapshot => snapshot.targets.some(target => !settled.has(target));
  function resolveWaiters(ticket, ok) {
    for (const waiter of waiters) if (waiter.generation <= ticket.generation) {
      waiters.delete(waiter); waiter.resolve(ok);
    }
  }
  function stop() {
    if (retry !== null) { cancel(retry); retry = null; }
    const previous = flight; flight = null;
    if (previous) {
      requested ||= previous.requested;
      cancel(previous.deadline); previous.controller.abort(); resolveWaiters(previous, false);
    }
  }
  function finish(ticket, response, failed = false) {
    if (!owns(ticket)) return;
    cancel(ticket.deadline);
    if (failed) ticket.controller.abort();
    let accepted = [];
    if (!failed) {
      try { accepted = accept(response, ticket.snapshot) ?? []; }
      catch { failed = true; }
    }
    flight = null;
    for (const target of accepted) settled.add(target);
    const current = capture();
    const pending = unresolved(current);
    resolveWaiters(ticket, !failed);
    if (failed) requested = true;
    if (!requested && !pending) { failures = 0; return; }
    // A new identity that arrived during this read has never had an attempt.
    if (!failed && current.targets.some(target => !settled.has(target) && !ticket.snapshot.targets.includes(target))) {
      failures = 0; acquire(); return;
    }
    const delay = Math.min(30000, 1000 * 2 ** Math.min(failures++, 5));
    retry = schedule(() => { retry = null; acquire(); }, delay);
  }
  function acquire() {
    if (!active() || flight || retry !== null) return;
    const snapshot = capture();
    if (!requested && !unresolved(snapshot)) return;
    const ticket = { snapshot, generation, requested, controller: new AbortController() };
    requested = false; flight = ticket;
    ticket.deadline = schedule(() => finish(ticket, undefined, true), DISCOVERY_DEADLINE_MS);
    Promise.resolve().then(() => owns(ticket) ? read({ signal: ticket.controller.signal }) : undefined)
      .then(response => finish(ticket, response), () => finish(ticket, undefined, true));
  }
  function reconcile() {
    if (disposed) return;
    const targets = new Set(capture().targets);
    if (flight && flight.snapshot.targets.length && !flight.snapshot.targets.some(target => targets.has(target))) stop();
    if (!targets.size) {
      requested = false;
      if (retry !== null) { cancel(retry); retry = null; }
    }
    acquire();
  }
  return {
    start() { if (disposed || started) return; started = true; acquire(); },
    reconcile,
    refresh({ invalidate = false } = {}) {
      if (disposed) return Promise.resolve(false);
      started = true; // The retained public refresh port also works before boot.
      if (invalidate) { stop(); generation++; }
      if (!flight) {
        if (retry !== null) { cancel(retry); retry = null; }
        settled = new WeakSet(); requested = true; failures = 0;
      }
      const task = new Promise(resolve => waiters.add({ generation, resolve }));
      acquire(); return task;
    },
    suspend() { if (disposed || suspended) return; suspended = true; stop(); },
    resume() { if (disposed || !suspended) return; suspended = false; reconcile(); },
    dispose() {
      if (disposed) return;
      disposed = true; stop(); settled = new WeakSet();
      for (const waiter of waiters) waiter.resolve(false);
      waiters.clear();
    },
  };
}
