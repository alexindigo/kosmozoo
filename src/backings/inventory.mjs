// Pure membership/time validation and the sole published inventory comparator.
import { inventoryFolders } from "../entry-path.mjs";

export class InventoryError extends Error {
  constructor(code, message, details = {}) {
    super(message); this.name = "InventoryError"; this.code = code;
    Object.assign(this, details);
  }
}

export const cancelled = (message = "Source incarnation changed") =>
  new InventoryError("cancelled", message, { status: 499 });

export function freezeTree(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

export function compareInventory(a, b) {
  return b.modified.atMs - a.modified.atMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

export function validateModified(value) {
  if (!value || !Number.isFinite(value.atMs) ||
      !(value.precisionMs === null || Number.isFinite(value.precisionMs) && value.precisionMs > 0) ||
      !["http-last-modified", "filesystem-stat"].includes(value.source)) {
    throw new InventoryError("invalid-time", "Invalid source modification time");
  }
  return { atMs: value.atMs, precisionMs: value.precisionMs, source: value.source };
}

export function finalizeInventory({ records, discovered, unavailable = [], coverage, subfolders, flat = false }) {
  if (!Array.isArray(records) || !Array.isArray(discovered) || !Array.isArray(unavailable) ||
      !["recursive", "root-only"].includes(coverage) || !subfolders || typeof subfolders.supported !== "boolean") {
    throw new InventoryError("invalid-inventory", "Invalid inventory candidate");
  }
  const membership = new Set(discovered);
  if ([...membership].some((name) => typeof name !== "string" || !name)) throw new InventoryError("invalid-name", "Invalid discovered address");
  const entries = new Map(), absent = new Map();
  for (const record of records) {
    if (!record || !membership.has(record.name) ||
        !(record.size === null || Number.isSafeInteger(record.size) && record.size >= 0)) {
      throw new InventoryError("invalid-record", "Invalid available inventory record", { path: record?.name });
    }
    const next = { name: record.name, size: record.size, modified: validateModified(record.modified) };
    const prior = entries.get(next.name);
    if (prior && JSON.stringify(prior) !== JSON.stringify(next)) throw new InventoryError("duplicate", `Conflicting inventory address: ${next.name}`);
    entries.set(next.name, next);
  }
  for (const record of unavailable) {
    if (!record || !membership.has(record.name) || record.status !== 404 || typeof record.reason !== "string" || entries.has(record.name)) {
      throw new InventoryError("invalid-unavailable", "Invalid unavailable-file observation", { path: record?.name });
    }
    absent.set(record.name, { name: record.name, reason: record.reason, status: 404 });
  }
  return freezeTree({ items: [...entries.values()].sort(compareInventory),
    unavailable: [...absent.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    folders: flat ? [""] : inventoryFolders([...membership].map((name) => ({ name }))),
    coverage, subfolders: { ...subfolders }, chronology: { order: "modified-desc", complete: true } });
}

// Logical cancellation/deadlines settle even if a transport ignores abort.
// The underlying promise remains observed, never gains publication authority.
export function bounded(task, { signal, timeoutMs, timeoutError, onTimeout } = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? cancelled());
  return new Promise((resolve, reject) => {
    let done = false, timer;
    const finish = (fn, value) => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); fn(value);
    };
    const abort = () => finish(reject, signal.reason ?? cancelled());
    signal?.addEventListener("abort", abort, { once: true });
    if (Number.isFinite(timeoutMs)) timer = setTimeout(() => {
      const error = timeoutError ?? new InventoryError("timeout", "Inventory operation timed out");
      onTimeout?.(error); finish(reject, error);
    }, Math.max(0, timeoutMs));
    Promise.resolve().then(() => {
      if (signal?.aborted) throw signal.reason ?? cancelled();
      return task();
    }).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}
