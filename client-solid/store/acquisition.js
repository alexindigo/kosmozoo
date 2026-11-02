// One Store-owned identity projection and admission scheduler. Executors retain
// their own resources; every queued start and late publication shares this scope.
export function acquisitionWindow({ ids, currentId, viewportIds = [], limit = 20 }) {
  if (!ids.length) return [];
  const positions = new Map(ids.map((id, index) => [id, index]));
  const visible = viewportIds.map(id => positions.get(id)).filter(index => index !== undefined);
  const selected = positions.get(currentId);
  const inViewport = selected !== undefined && (!visible.length || selected >= Math.min(...visible) && selected <= Math.max(...visible));
  const anchor = inViewport ? selected : visible[Math.floor(visible.length / 2)] ?? selected ?? 0;
  const out = selected !== undefined ? [ids[selected]] : [];
  if (!out.includes(ids[anchor]) && out.length < limit) out.push(ids[anchor]);
  for (let distance = 1; out.length < Math.min(limit, ids.length); distance++) {
    if (anchor + distance < ids.length && !out.includes(ids[anchor + distance])) out.push(ids[anchor + distance]);
    if (out.length < limit && anchor - distance >= 0 && !out.includes(ids[anchor - distance])) out.push(ids[anchor - distance]);
  }
  return out;
}

// requestIdleCallback supplies a real idle budget. postTask's background lane
// is the alternative; a cancellable timer keeps unsupported browsers progressing.
function scheduleIdle(callback) {
  if (typeof globalThis.requestIdleCallback === "function") {
    const id = requestIdleCallback(callback, { timeout: 1000 });
    return () => cancelIdleCallback(id);
  }
  if (globalThis.scheduler?.postTask) {
    const controller = new AbortController();
    scheduler.postTask(() => callback({ timeRemaining: () => 8 }),
      { priority: "background", signal: controller.signal }).catch(error => {
        if (error.name !== "AbortError") console.error(error);
      });
    return () => controller.abort();
  }
  const id = setTimeout(() => callback({ timeRemaining: () => 8 }), 16);
  return () => clearTimeout(id);
}

// fallbackPriority ranks jobs outside the projected window. The Store's policy
// keeps the default; a consumer with no projection may rank everything foreground.
export function makeAcquisition({ now = () => performance.now(), scheduleIdle: idle = scheduleIdle,
  fallbackPriority = "background" } = {}) {
  const queued = new Map(), active = new Set();
  let context = null, foreground = new Set(), gesture = false, disposed = false;
  let cancelIdle = null, pumping = false, windowVersion = 0;
  // A scoped job belongs to the source context it was submitted in. An
  // unscoped job (a modal surface's display) is retired only by its owner.
  const current = job => !disposed && (!job.scoped || job.context === context) && !job.cancelled && (!job.valid || job.valid());
  const priority = job => (typeof job.priority === "function" ? job.priority() : job.priority) ??
    (foreground.has(job.id) ? "foreground" : fallbackPriority);
  const foregroundPending = () => [...queued.values(), ...active].some(job => current(job) && priority(job) === "foreground");
  const slots = lane => [...active].filter(job => job.resource && job.lane === lane).length;

  function finish(job, result, error) {
    active.delete(job);
    if (error) job.reject(error); else job.resolve(current(job) ? result : { retired: true });
    pump();
  }

  function start(job) {
    queued.delete(job.key);
    if (!current(job)) { job.resolve({ retired: true }); return; }
    job.lane = priority(job);
    active.add(job);
    try {
      const result = job.run({ priority: job.lane, current: () => current(job),
        // An executor which actually aborts its resource can synchronously
        // release capacity before staging replacement content.
        release: () => { active.delete(job); pump(); } });
      Promise.resolve(result).then(value => finish(job, value), error => finish(job, null, error));
    } catch (error) { finish(job, null, error); }
  }

  function eligible(job, lane) {
    return priority(job) === lane && (!job.resource || slots(lane) < (lane === "background" ? 2 : 6));
  }

  function pump(deadline) {
    if (disposed || pumping) return;
    pumping = true;
    const started = now();
    try {
      for (const job of queued.values()) if (!current(job)) { queued.delete(job.key); job.resolve({ retired: true }); }
      if (gesture) return;
      for (const job of queued.values()) if (eligible(job, "foreground")) start(job);
      if (foregroundPending()) { cancelIdle?.(); cancelIdle = null; return; }
      if (deadline) {
        for (const job of queued.values()) {
          if (gesture || foregroundPending() || now() - started >= 8 || !deadline.didTimeout && deadline.timeRemaining() <= 0) break;
          if (eligible(job, "background")) start(job);
        }
      }
      if ([...queued.values()].some(job => eligible(job, "background")) && !cancelIdle) {
        cancelIdle = idle(budget => { cancelIdle = null; pump(budget); });
      }
    } finally { pumping = false; }
  }

  function submit({ key, id = null, valid, priority: lane, resource = true, scoped = true, run }) {
    if (disposed) return Promise.resolve({ retired: true });
    const existing = queued.get(key) ?? [...active].find(job => job.key === key && current(job));
    if (existing && current(existing)) return existing.promise;
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    queued.set(key, { key, id, valid, priority: lane, resource, scoped, run, context, promise, resolve, reject });
    pump();
    return promise;
  }

  function cancel(key) {
    const job = queued.get(key);
    if (job) { queued.delete(key); job.cancelled = true; job.resolve({ retired: true }); }
    for (const job of active) if (job.key === key) job.cancelled = true;
  }

  function setContext(next) {
    if (context === next) return;
    context = next;
    cancelIdle?.(); cancelIdle = null;
    for (const job of [...queued.values()]) if (job.scoped) { queued.delete(job.key); job.resolve({ retired: true }); }
    foreground.clear(); windowVersion++;
  }

  return {
    submit, cancel, setContext, reconcile: pump,
    setWindow(projection) {
      const next = acquisitionWindow(projection);
      if (next.length !== foreground.size || next.some(id => !foreground.has(id))) {
        foreground = new Set(next); windowVersion++;
      }
      pump(); return next;
    },
    windowVersion: () => windowVersion,
    foregroundIds: () => foreground.values(),
    priority: id => foreground.has(id) ? "foreground" : fallbackPriority,
    setGesture(active) { gesture = active; if (gesture) { cancelIdle?.(); cancelIdle = null; } else pump(); },
    dispose() { if (disposed) return; setContext(Symbol("retired")); disposed = true; },
  };
}
