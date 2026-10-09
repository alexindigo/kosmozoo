// Version1 authoritative source snapshots. Validation precedes every consumer write.
const integer = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === "string" && value.length > 0;
const record = value => value && typeof value === "object" && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
  Reflect.ownKeys(value).every(key => typeof key === "string" && Object.getOwnPropertyDescriptor(value, key).enumerable &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"));
const shape = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function validSourceVersion(value) {
  return shape(value, ["epoch", "incarnation", "attributesRevision"]) && text(value.epoch) &&
    text(value.incarnation) && integer(value.attributesRevision);
}

export const validSourceCursor = value => shape(value, ["epoch", "revision"]) && text(value.epoch) && integer(value.revision);

export function compareSourceVersions(a, b) {
  if (!validSourceVersion(a) || !validSourceVersion(b) || a.epoch !== b.epoch || a.incarnation !== b.incarnation) return null;
  return Math.sign(a.attributesRevision - b.attributesRevision);
}

export function validateSourceSnapshot(frame) {
  const invalid = () => { throw new Error("Invalid source snapshot; full resynchronization required"); };
  if (!shape(frame, ["version", "epoch", "revision", "sources"]) || frame.version !== 1 || !text(frame.epoch) ||
      !integer(frame.revision) || !record(frame.sources)) invalid();
  for (const [id, source] of Object.entries(frame.sources)) {
    if (!text(id) || !shape(source, ["address", "kind", "incarnation", "pinned", "autoRefresh", "sourceVersion", "activity"]) ||
        !text(source.address) || !["folder", "comfy"].includes(source.kind) || !text(source.incarnation) ||
        typeof source.pinned !== "boolean" || typeof source.autoRefresh !== "boolean" || !validSourceVersion(source.sourceVersion) ||
        source.sourceVersion.epoch !== frame.epoch || source.sourceVersion.incarnation !== source.incarnation ||
        source.address.startsWith("folder:") !== (source.kind === "folder")) invalid();
    const a = source.activity;
    if (source.kind === "folder") {
      if (!shape(a, ["supported", "reason"]) || a.supported !== false || !text(a.reason)) invalid();
      continue;
    }
    if (!shape(a, ["epoch", "supported", "state", "sampledAt", "runningCount", "queuedCount", "runningPromptId", "progress",
      "terminalRevision", "resyncRevision", "historyGap", "error"]) || a.supported !== true || !text(a.epoch) ||
        !["unknown", "idle", "running", "disconnected"].includes(a.state) ||
        !(a.sampledAt === null || Number.isFinite(a.sampledAt)) || !integer(a.runningCount) || !integer(a.queuedCount) ||
        !(a.runningPromptId === null || text(a.runningPromptId)) || !integer(a.terminalRevision) || !integer(a.resyncRevision) ||
        typeof a.historyGap !== "boolean" || !(a.error === null || typeof a.error === "string")) invalid();
    if (a.progress !== null && (!shape(a.progress, ["value", "max", "fraction"]) || !Number.isFinite(a.progress.value) ||
        a.progress.value < 0 || !Number.isFinite(a.progress.max) || a.progress.max <= 0 || !Number.isFinite(a.progress.fraction) ||
        a.progress.fraction < 0 || a.progress.fraction > 1)) invalid();
  }
  return frame;
}

// The adapter closes native retry before owning a single capped/jittered retry.
export function subscribeSources({ onSnapshot, onConnection }, { createEventSource = url => new EventSource(url),
  setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random, url = "/api/events" } = {}) {
  let retired = false, generation = 0, source = null, timer = null, errors = 0;
  const close = () => { generation++; const previous = source; source = null; previous?.close(); };
  const failed = error => {
    if (retired || timer !== null) return;
    close(); onConnection("reconnecting", error);
    const delay = Math.min(30000, 1000 * 2 ** Math.min(errors++, 5) * (.8 + .4 * random()));
    timer = setTimer(() => { timer = null; connect(); }, delay);
  };
  function connect() {
    if (retired) return;
    const own = ++generation;
    onConnection("connecting");
    try {
      const instance = createEventSource(url); source = instance;
      const current = () => !retired && generation === own && source === instance;
      instance.addEventListener("sources", event => {
        if (!current()) return;
        try {
          const snapshot = validateSourceSnapshot(JSON.parse(event.data));
          if (event.lastEventId !== `${snapshot.epoch}:${snapshot.revision}` || onSnapshot(snapshot) === false) {
            throw new Error("Source snapshot ordering requires resynchronization");
          }
          if (!current()) return;
          errors = 0; onConnection("ready");
        } catch (error) { if (current()) failed(error); }
      });
      instance.onerror = () => { if (current()) failed(new Error("Source event delivery disconnected")); };
    } catch (error) { if (!retired && generation === own) failed(error); }
  }
  const dispose = () => { if (retired) return; retired = true; clearTimer(timer); timer = null; close(); };
  dispose.resync = () => failed(new Error("Full source resynchronization requested"));
  connect();
  return dispose;
}
