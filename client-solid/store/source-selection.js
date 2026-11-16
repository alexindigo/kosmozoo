export const SOURCE_SELECTION_KEY = "kosmozoo.sourceSelection.v1";
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const name = value => typeof value === "string" && value.length > 0;
const valid = value => object(value) && name(value.address) && Array.isArray(value.names) && value.names.every(name);

export function makeSourceSelection({ storage, onError = () => {} }) {
  const session = new Map(), dirty = new Set();
  let blocked = false, reported = false;
  const unavailable = (reason, preserve = false) => {
    if (preserve) blocked = true;
    if (!reported) { reported = true; onError(`Card selection memory unavailable: ${reason}; using session memory`); }
  };
  const atStorage = () => typeof storage === "function" ? storage() : storage;
  const read = () => {
    if (blocked) return null;
    try {
      const target = atStorage();
      if (!target) throw new Error("browser storage is unavailable");
      const bytes = target.getItem(SOURCE_SELECTION_KEY);
      if (bytes === null) return { version: 1, hosts: {} };
      let document;
      try { document = JSON.parse(bytes); }
      catch { unavailable("invalid JSON preserved", true); return null; }
      if (!object(document) || document.version !== 1 || !object(document.hosts)) {
        unavailable("unsupported version or document shape preserved", true); return null;
      }
      return document;
    } catch (error) { unavailable(error.message); return null; }
  };
  const names = (id, address) => {
    const hosts = read()?.hosts;
    const stored = hosts && Object.hasOwn(hosts, id) ? hosts[id] : null;
    const value = !dirty.has(id) && valid(stored) ? stored : session.get(id);
    if (valid(value)) session.set(id, { address: value.address, names: [...new Set(value.names)] });
    return valid(value) && value.address === address ? [...new Set(value.names)] : [];
  };
  const save = (id, address, selected) => {
    if (!name(id) || !name(address) || !selected.every(name)) return false;
    const value = { address, names: [...new Set(selected)] };
    session.set(id, value); dirty.add(id);
    const latest = read();
    if (!latest) return false;
    try {
      atStorage().setItem(SOURCE_SELECTION_KEY, JSON.stringify({ ...latest, hosts: { ...latest.hosts, [id]: value } }));
      dirty.delete(id); return true;
    } catch (error) { unavailable(error.message); return false; }
  };
  read();
  return {
    names,
    has: (id, address, entry) => names(id, address).includes(entry),
    set(id, address, entry, on) {
      if (!name(entry) || typeof on !== "boolean") return false;
      const selected = names(id, address).filter(value => value !== entry);
      if (on) selected.push(entry);
      return save(id, address, selected);
    },
    clear: (id, address) => save(id, address, []),
    remove(id, address, entries) { const removed = new Set(entries); return save(id, address, names(id, address).filter(value => !removed.has(value))); },
    prune(id, address, keepNames) {
      const keep = new Set(keepNames), selected = names(id, address), retained = selected.filter(value => keep.has(value));
      return selected.length === retained.length || save(id, address, retained);
    },
    resolvePersistence() {
      blocked = false;
      const available = read() !== null;
      if (available) reported = false;
      return available;
    },
  };
}
