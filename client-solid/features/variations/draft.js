// Native Web Crypto entropy also works on the app's HTTP LAN origin, where
// randomUUID is unavailable. Correlation remains standard fresh version4 UUIDs.
export function createRunId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Owner-private snapshots: containers are copied, File references/order retained.
export function snapshotDraft(value) {
  if (value == null || typeof value !== "object") return value;
  if (typeof File !== "undefined" && value instanceof File) return value;
  if (Array.isArray(value)) return value.map(snapshotDraft);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshotDraft(item)]));
}
export function sameDraft(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (typeof File !== "undefined" && (a instanceof File || b instanceof File)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameDraft(a[key], b[key]));
}

export function makeLeaveGuard({ dirty, suspend, restore, decision, invalidate }) {
  let pending = null, alive = true;
  const settle = (record, status) => {
    if (pending === record) { pending = null; decision(null); }
    record.resolve(status);
  };
  const commit = (record) => {
    if (!alive || pending !== record) return;
    record.committing = true;
    // Consume before permit: unmount cleanup cannot cancel an applied transition.
    pending = null;
    decision(null);
    try {
      const result = record.permit();
      if (result.status !== "applied" && record.suspended) restore();
      record.resolve(result);
    } catch (error) { if (record.suspended) restore(); record.reject(error); }
  };
  return {
    request(request) {
      if (!alive) return Promise.resolve({ status: "stale" });
      const key = JSON.stringify(request.intent);
      if (pending) return key === pending.key ? pending.promise : Promise.resolve({ status: "busy" });
      if (request.intent.type === "automatic" && dirty()) return Promise.resolve({ status: "stale" });
      invalidate();
      const record = { ...request, key, committing: false };
      record.promise = new Promise((resolve, reject) => { record.resolve = resolve; record.reject = reject; });
      pending = record;
      if (!dirty()) commit(record);
      else { record.suspended = true; suspend(); decision(record.intent); }
      return record.promise;
    },
    pending: () => !!pending,
    cancel() {
      if (!pending) return;
      const record = pending;
      try { record.cancel(); settle(record, { status: "cancelled" }); restore(); }
      catch (error) { pending = null; decision(null); record.reject(error); }
    },
    discard() { if (pending) commit(pending); },
    dispose() {
      alive = false;
      if (pending && !pending.committing) settle(pending, { status: "stale" });
    },
  };
}

// Called by the child at its own input surface, before a close trigger steals
// focus. The owner receives a restoration callback, never an element/caret.
export function focusMemory(remember) {
  const capture = (event) => {
    const element = event.currentTarget;
    const start = element.selectionStart, end = element.selectionEnd, direction = element.selectionDirection;
    remember?.(() => {
      if (!element.isConnected) return;
      element.focus();
      if (start != null && end != null) element.setSelectionRange(start, end, direction);
    });
  };
  return { onFocus: capture, onSelect: capture, onKeyUp: capture, onMouseUp: capture, onBlur: capture };
}
