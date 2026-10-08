// Per-store semantic ports. Executors and owner capabilities never escape.
export function assertData(value, { files = false } = {}, seen = new Set()) {
  if (value == null || ["string", "boolean"].includes(typeof value)) return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (files && typeof File !== "undefined" && value instanceof File) return;
  if (typeof value !== "object" || seen.has(value) ||
      (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError("Command payload must contain data only");
  }
  seen.add(value);
  for (const item of Object.values(value)) assertData(item, { files }, seen);
  seen.delete(value);
}

export function makeCommandHandles({ observe = () => {} } = {}) {
  const ports = new Map();
  const owners = new Map();
  const ownedIds = new Set();
  const get = (id) => {
    if (!ports.has(id)) throw new Error(`Unknown command: ${id}`);
    return ports.get(id);
  };
  const register = ({ id, description = id, validate = () => true, execute, files = false }) => {
    if (typeof id !== "string" || !id || ports.has(id)) throw new Error(`Duplicate or invalid command: ${id}`);
    if (typeof execute !== "function") throw new TypeError(`Missing capability: ${id}`);
    const handle = Object.freeze({
      id, description,
      invoke(args = {}) {
        assertData(args, { files });
        if (!args || Array.isArray(args) || typeof args !== "object" || validate(args) !== true) {
          throw new TypeError(`Invalid payload: ${id}`);
        }
        const result = execute(args);
        observe(result);
        return result;
      },
    });
    ports.set(id, handle);
    return handle;
  };
  return Object.freeze({
    get, register,
    invoke: (id, args) => get(id).invoke(args),
    list: () => [...ports.values()].map(({ id, description }) => ({ id, description })),
    // Local presentation owners expose a capability, not their private state.
    registerOwned(definition) {
      const port = register({ ...definition, execute: (args) => {
        const owner = owners.get(definition.id);
        return owner ? owner.execute(args) : false;
      } });
      ownedIds.add(definition.id);
      return port;
    },
    own(id, execute) {
      get(id);
      if (!ownedIds.has(id)) throw new Error(`Command is not owner-scoped: ${id}`);
      if (typeof execute !== "function") throw new TypeError("Invalid owner capability");
      const registration = { execute };
      owners.set(id, registration);
      return () => { if (owners.get(id) === registration) owners.delete(id); };
    },
  });
}
