import { isEntryPath, isFolderPath } from "/shared/entry-path.mjs";

export const SOURCE_BROWSE_KEY = "kosmozoo.sourceBrowse.v1";
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// One last pair per source, with injected browser storage and reporting. A
// corrupt/future document is preserved, and persistence never owns navigation.
export function makeSourceBrowse({ storage, onError = () => {}, validCurrent = (_address, name) => isEntryPath(name) }) {
  const validPair = (pair) => object(pair) && typeof pair.address === "string" && pair.address.length > 0 &&
    isFolderPath(pair.folder) && (pair.current === null || validCurrent(pair.address, pair.current));
  const session = new Map(), dirty = new Set();
  let blocked = false, reported = false;
  const unavailable = (reason, preserve = false) => {
    if (preserve) blocked = true;
    if (!reported) { reported = true; onError(`Source browsing memory unavailable: ${reason}; using session memory`); }
  };
  const atStorage = () => typeof storage === "function" ? storage() : storage;
  function read() {
    if (blocked) return null;
    try {
      const target = atStorage();
      if (!target) throw new Error("browser storage is unavailable");
      const bytes = target.getItem(SOURCE_BROWSE_KEY);
      if (bytes === null) return { version: 1, hosts: {} };
      let document;
      try { document = JSON.parse(bytes); }
      catch { unavailable("invalid JSON preserved", true); return null; }
      if (!object(document) || document.version !== 1 || !object(document.hosts)) {
        unavailable("unsupported version or document shape preserved", true); return null;
      }
      return document;
    } catch (error) { unavailable(error.message); return null; }
  }
  read();
  return {
    get(id, address) {
      const stored = read()?.hosts;
      const pair = !dirty.has(id) && validPair(stored?.[id]) ? stored[id] : session.get(id);
      if (validPair(pair)) session.set(id, { ...pair });
      return validPair(pair) && pair.address === address ? { ...pair } : undefined;
    },
    set(id, pair) {
      if (!validPair(pair)) return false;
      const saved = { address: pair.address, folder: pair.folder, current: pair.current };
      session.set(id, saved); dirty.add(id);
      const latest = read();
      if (!latest) return false;
      try {
        // Preserve every other host (including ignored invalid records) and
        // unknown document fields. Read immediately before this single write.
        atStorage().setItem(SOURCE_BROWSE_KEY, JSON.stringify({ ...latest, hosts: { ...latest.hosts, [id]: saved } }));
        dirty.delete(id);
        return true;
      } catch (error) { unavailable(error.message); return false; }
    },
    // Explicit resolution only: callers may resume after a human repairs the
    // stored bytes. No storage-event listener or automatic navigation exists.
    resolvePersistence() {
      blocked = false;
      const available = read() !== null;
      if (available) reported = false;
      return available;
    },
  };
}
