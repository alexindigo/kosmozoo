// One feature-private read/mutation owner shared by both presentations. Drafts
// remain in their mounted editor, never in this readonly leased-record cache.
import { encodeHistoryRecipe } from "/shared/features/variations/history-codec.mjs";
import { sameDraft } from "/shared/features/variations/recipe-model.mjs";

export function makeHistoryClient({ api, changed = () => {} }) {
  let alive = true, generation = 0, reading = null, interests = 0, nextCursor = null;
  let items = [], error = "", loaded = false;
  const removed = new Set(), details = new Map(), leases = new Map(), deleting = new Set();
  const releasing = new Map(), pendingRelease = new Set();
  const acquisitions = new Set(), acknowledged = new Set(), releaseErrors = new Map();
  let draining = null, retirement = null;
  const notify = () => { if (alive) changed(); };
  const refresh = (more = false) => {
    if (!alive || more && !nextCursor) return Promise.resolve();
    if (reading) return reading;
    const ticket = generation, before = more ? nextCursor : null;
    error = "";
    const task = Promise.resolve().then(() => api.historyList(before)).then(page => {
      if (!alive || ticket !== generation) return;
      if (page.format !== 1 || !Array.isArray(page.items)) throw new Error("Unsupported history response");
      const incoming = page.items.filter(item => !removed.has(item.id)).map(item => {
        const previous = items.find(old => old.id === item.id);
        return previous && sameDraft(previous, item) ? previous : item;
      });
      items = more ? [...items, ...incoming.filter(item => !items.some(old => old.id === item.id))] : incoming;
      nextCursor = page.nextCursor; loaded = true;
    }).catch(problem => { if (alive && ticket === generation) error = problem.message; }).finally(() => {
      if (reading === task) { reading = null; notify(); }
    });
    reading = task; notify(); return task;
  };
  const release = record => {
    if (!record?.leaseId) return Promise.resolve();
    const key = record.leaseId;
    if (acknowledged.has(key)) return Promise.resolve();
    if (releasing.has(key)) return releasing.get(key);
    leases.set(key, record); pendingRelease.add(key);
    const task = Promise.resolve().then(() => api.historyRelease(record.id, key)).then(() => {
      acknowledged.add(key); leases.delete(key); pendingRelease.delete(key); releaseErrors.delete(key);
    }).catch(problem => { releaseErrors.set(key, problem); error = `History lease release failed: ${problem.message}`; notify(); throw problem; })
      .finally(() => { if (releasing.get(key) === task) releasing.delete(key); });
    releasing.set(key, task); return task;
  };
  const retire = (record, pass) => {
    if (!record?.leaseId || acknowledged.has(record.leaseId)) return;
    if (!pass.has(record.leaseId)) {
      const task = release(record).catch(() => release(record));
      // Late acquisitions may fail before the drain reaches allSettled.
      task.catch(() => {}); pass.set(record.leaseId, task);
    }
  };
  const dispose = () => {
    alive = false; generation++; reading = null; details.clear();
    if (draining) return draining;
    const pass = new Map(); retirement = pass;
    for (const record of leases.values()) retire(record, pass);
    const task = Promise.allSettled([...acquisitions]).then(() => Promise.allSettled([...pass.values()]));
    draining = task;
    task.then(() => { if (draining === task) { draining = null; retirement = null; } });
    return task;
  };
  return {
    state: () => ({ items, error, pending: !!reading, loaded, more: !!nextCursor, deleting: new Set(deleting) }),
    refresh, more: () => refresh(true),
    interest() { interests++; refresh(); let owned = true; return () => { if (owned) interests--; owned = false; }; },
    activate() {
      if (!alive) return dispose();
      const cleanup = [...pendingRelease].map(key => release(leases.get(key)));
      if (interests) cleanup.push(refresh());
      return Promise.allSettled(cleanup);
    },
    async detail(id) {
      if (!alive || removed.has(id)) throw new Error("History entry unavailable");
      if (!details.has(id)) details.set(id, api.historyDetail(id).catch(error => { details.delete(id); throw error; }));
      const result = await details.get(id);
      if (!alive || removed.has(id)) throw new Error("History entry unavailable");
      return result;
    },
    async open(id) {
      if (!alive || removed.has(id)) throw new Error("History entry unavailable");
      // Track only acquisition/enrollment, never the public continuation that
      // may await retirement. Otherwise disposal and open would await each other.
      let accept, reject;
      const transport = new Promise((yes, no) => { accept = yes; reject = no; });
      const acquisition = transport.then(record => {
        if (!acknowledged.has(record.leaseId)) leases.set(record.leaseId, record);
        if (retirement) retire(record, retirement);
        return record;
      });
      acquisitions.add(acquisition);
      acquisition.then(() => acquisitions.delete(acquisition), () => acquisitions.delete(acquisition));
      try { accept(api.historyOpen(id)); } catch (problem) { reject(problem); }
      const record = await acquisition;
      if (!alive || removed.has(id)) {
        let cause;
        if (!alive) {
          await dispose(); cause = releaseErrors.get(record.leaseId);
        } else { try { await release(record); } catch (problem) { cause = problem; } }
        throw new Error("History entry unavailable", cause ? { cause } : undefined);
      }
      return record;
    },
    retained: (id, leaseId) => { const record = leases.get(leaseId); return record?.id === id ? record : null; },
    release,
    async remove(id) {
      if (deleting.has(id)) return;
      deleting.add(id); error = ""; notify();
      try {
        await api.historyRemove(id);
        if (!alive) return;
        generation++; reading = null; removed.add(id); details.delete(id); items = items.filter(item => item.id !== id);
      } catch (problem) { if (alive) error = problem.message; }
      finally { deleting.delete(id); notify(); }
    },
    // Called synchronously from the issued Run, before awaiting inspections.
    async capture(ticket, contexts, check) {
      const encoded = encodeHistoryRecipe(ticket.snapshot, ticket.runId);
      const targets = ticket.targets.map(target => ({ id: target.id, host: target.host, filename: target.filename, origin: target.origin,
        ...(contexts.get(target.id) ?? target.context ? { context: contexts.get(target.id) ?? target.context } : {}),
        ...(target.historyRef ? { historyRef: target.historyRef } : {}) }));
      await api.historyBegin({ runId: ticket.runId, format: encoded.format, cohortMode: targets.length > 1 ? "bulk" : "single",
        targets, recipe: encoded.recipe, resources: encoded.resources });
      for (const target of targets) check(target);
      // Bounded, disk-backed archive uploads; never upstream materialization.
      const files = [...encoded.files]; let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
        while (next < files.length) {
          const [id, file] = files[next++]; for (const target of targets) check(target);
          await api.historyBytes(ticket.runId, id, file);
        }
      }));
      const prepared = await api.historyPrepare(ticket.runId);
      for (const target of targets) check(target);
      return prepared;
    },
    async plans(ticket, prepared, check) {
      const plans = [];
      for (const [targetIndex, target] of ticket.targets.entries()) {
        check(target);
        const binding = { targetIndex, origin: target.origin, snapshotHash: prepared.snapshotHash };
        const saved = prepared.targets[targetIndex], resources = new Set(Object.values(saved.graphResources));
        for (const entry of Object.values(prepared.recipe.images)) if (entry.values.enabled) for (const item of entry.values.items) {
          resources.add(item.kind === "target" ? `target-${targetIndex}` : item.resourceId);
        }
        for (const resourceId of resources) { check(target); await api.historyMaterialize(ticket.runId, { ...binding, resourceId }); }
        check(target);
        const plan = await api.historyTarget(ticket.runId, binding);
        check(target);
        if (plan.request?.history?.id !== ticket.runId || plan.request.history.snapshotHash !== prepared.snapshotHash ||
          plan.request.history.targetIndex !== targetIndex || plan.planHash !== plan.request.history.planHash) throw new Error("Saved target plan binding unavailable");
        plans.push({ ...plan, target });
      }
      return plans;
    },
    async finish(id, message) {
      try { await api.historyFinish(id, message); }
      finally { details.delete(id); if (alive) { generation++; reading = null; await refresh(); } }
    },
    dispose,
  };
}
