import { faceEyes } from "./geometry.mjs";
import { faceAddress, faceContent } from "./identity.mjs";

const freeze = value => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

// Private, bounded, cancellable single-flight owner. Only immutable snapshots
// leave it; failures are never records. Requests and choices share one lifetime.
export function makeFaceModel({ detect, changed = () => {}, limit = 24 }) {
  // Successes and failures share one LRU budget; neither can accumulate in
  // an unbounded parallel map. Active/accepted records are pinned together.
  const cache = new Map();
  let lifetime = null, wanted = [], retained = [], active = null, disposed = false, serial = 0, enabled = true;
  const publish = () => { if (!disposed) changed(); };
  function entryFor(resource, recordId) {
    if (!resource) return null;
    const address = faceAddress(resource);
    if (recordId !== undefined) return [...cache.values()].find(entry => entry.address === address && entry.record?.id === recordId &&
      (!resource.hash || resource.hash === entry.record.image.hash)) ?? null;
    const hash = resource.hash ?? wanted.find(current => faceAddress(current) === address)?.hash;
    if (hash) return cache.get(faceContent(resource, hash)) ?? null;
    const unbound = cache.get(faceContent(resource, null));
    if (unbound) return unbound;
    // Only a unique cached version can resolve an otherwise unknown address.
    // Current interests retain learned content identity across metadata gaps;
    // no "newest record" or LRU-order alias can retarget accepted pixels.
    const versions = [...cache.values()].filter(entry => entry.address === address);
    return versions.length === 1 ? versions[0] : null;
  }
  function read(resource, recordId) {
    const entry = entryFor(resource, recordId);
    if (entry) { cache.delete(entry.key); cache.set(entry.key, entry); }
    return entry;
  }
  function trim() {
    const held = new Set(wanted.map(resource => entryFor(resource)?.key));
    for (const pin of retained) held.add(entryFor(pin.resource ?? pin, pin.recordId)?.key);
    for (const k of cache.keys()) { if (cache.size <= limit) break; if (!held.has(k)) cache.delete(k); }
  }
  const compatible = (job, resource) => faceAddress(resource) === job.address &&
    (!resource.hash || !job.expectedHash || resource.hash === job.expectedHash);
  function drain() {
    if (disposed || active || !lifetime || !enabled) return;
    const resource = wanted.find(r => !entryFor(r));
    if (!resource) return;
    const controller = new AbortController(), token = lifetime;
    const job = active = { address: faceAddress(resource), expectedHash: resource.hash ?? null, controller, order: ++serial };
    Promise.resolve().then(() => detect(resource, controller.signal)).then(result => {
      if (disposed || active !== job || lifetime !== token || !wanted.some(r => compatible(job, r))) return;
      if (job.expectedHash && job.expectedHash !== result.image.hash) {
        // Unknown -> known enrichment can reveal a genuine replacement while
        // the old inference is in flight. Retire it and acquire the known bytes.
        // A mismatching already-hash-bound response is a failure, not a retry loop.
        if (resource.hash) {
          const key = faceContent(resource, job.expectedHash);
          cache.set(key, { key, address: job.address, hash: job.expectedHash, error: "Detector content identity mismatch" }); trim();
        }
        return;
      }
      const key = faceContent(resource, result.image.hash);
      wanted = wanted.map(current => faceAddress(current) === job.address && (!current.hash || current.hash === result.image.hash)
        ? { ...current, hash: result.image.hash } : current);
      cache.delete(faceContent(resource, null));
      if (cache.has(key)) return;
      const id = `${job.order}:${result.image.hash}`;
      const faces = result.faces.map((face, index) => ({ ...face, id: `${id}:${index}`, selected: true, eyes: faceEyes(face) }));
      const usable = faces.filter(face => face.eyes);
      const { source, collection, kind, name, stamp, src, session } = resource;
      cache.set(key, { key, address: job.address, hash: result.image.hash,
        record: freeze({ id, resource: { source, collection, kind, name, stamp, hash: result.image.hash, src, session }, image: result.image, detector: result.detector,
        w: result.w, h: result.h, faces, anchor: usable.length === 1 && faces.length === 1 ? usable[0].id : null }) });
      trim();
    }, error => {
      if (!disposed && active === job && lifetime === token && error?.name !== "AbortError") {
        const key = faceContent(resource, job.expectedHash);
        cache.set(key, { key, address: job.address, hash: job.expectedHash, error: String(error?.message ?? error) || "Face detection failed" }); trim();
      }
    }).finally(() => {
      if (active !== job) return;
      active = null; publish(); drain();
    });
  }
  function retire() {
    active?.controller.abort(); active = null; cache.clear();
  }
  return {
    update(token, resources, displayed = [], allowWork = true) {
      if (disposed) return;
      if (lifetime !== token) { retire(); lifetime = token; wanted = []; }
      const previous = wanted;
      wanted = resources.filter(Boolean).map(resource => {
        const prior = previous.find(current => faceAddress(current) === faceAddress(resource));
        const hash = resource.hash ?? prior?.hash ?? entryFor(resource)?.hash;
        return { ...resource, ...(hash ? { hash } : {}) };
      });
      enabled = allowWork;
      retained = displayed;
      if (active) {
        const current = enabled && wanted.find(resource => compatible(active, resource));
        if (!current) { active.controller.abort(); active = null; }
        else if (current.hash && !active.expectedHash) active.expectedHash = current.hash;
      }
      trim(); drain(); publish();
    },
    record(resource, recordId) { return read(resource, recordId)?.record ?? null; },
    state(resource) {
      if (!resource) return { phase: "unavailable", message: "Still-image pair required" };
      const { record, error, notice } = read(resource) ?? {};
      if (error) return { phase: "error", message: error };
      if (!record) return { phase: "pending", message: "Detecting faces" };
      if (notice) return { phase: "choice-error", message: notice, record };
      if (!record.faces.length) return { phase: "empty", message: "No faces detected", record };
      if (!record.faces.some(face => face.eyes)) return { phase: "unusable", message: "Eye landmarks unavailable", record };
      return { phase: record.anchor ? "ready" : "choice", message: record.anchor ? "Face anchor ready" : "Double-click a face to align", record };
    },
    choose(resource, recordId, faceId) {
      const entry = read(resource, recordId), record = entry?.record;
      if (!enabled || !record || !wanted.some(r => entryFor(r)?.key === entry.key)) return false;
      const face = record.faces.find(f => f.id === faceId && f.selected);
      if (!face) return false;
      if (!face.eyes) {
        cache.set(entry.key, { ...entry, notice: "Selected face has no usable eye landmarks" }); publish(); return false;
      }
      cache.set(entry.key, { ...entry, notice: undefined, record: freeze({ ...record, anchor: faceId }) }); publish(); return true;
    },
    retry() {
      for (const [k, entry] of cache) if (Object.hasOwn(entry, "error")) cache.delete(k);
      drain(); publish();
    },
    dispose() { disposed = true; retire(); wanted = []; },
  };
}
