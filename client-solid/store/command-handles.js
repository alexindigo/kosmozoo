// Per-store semantic ports. Executors and owner capabilities never escape.
export function assertData(value, { files = false } = {}, seen = new Set()) {
  if (value == null || ["string", "boolean"].includes(typeof value)) return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  const file = files && typeof File !== "undefined" && value instanceof File && Object.getPrototypeOf(value) === File.prototype;
  const array = Array.isArray(value);
  if (typeof value !== "object" || seen.has(value) || (!file &&
      (array ? Object.getPrototypeOf(value) !== Array.prototype :
        Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))) {
    throw new TypeError("Command payload must contain data only");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  // Native File resources are opaque, identity-preserving inputs. Their runtime
  // brand/byte-storage symbols are not semantic record fields (Deno uses them).
  if (file) {
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, "value") || typeof descriptor.value === "function")
        throw new TypeError("File resources cannot carry callbacks");
    }
    return;
  }
  if (keys.some((key) => typeof key !== "string" || !Object.hasOwn(descriptors[key], "value") ||
      (!descriptors[key].enumerable && !(array && key === "length"))))
    throw new TypeError("Command payload must contain own data properties only");
  if (array && keys.length !== descriptors.length.value + 1)
    throw new TypeError("Command payload arrays must be dense");
  seen.add(value);
  try {
    for (const key of keys) {
      if (array && key !== "length" && (!Number.isInteger(Number(key)) || String(Number(key)) !== key || Number(key) < 0 || Number(key) >= descriptors.length.value))
        throw new TypeError("Command payload arrays must contain indexed data only");
      assertData(descriptors[key].value, { files }, seen);
    }
  } finally { seen.delete(value); }
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
    if (typeof description !== "string" || typeof validate !== "function" || typeof files !== "boolean")
      throw new TypeError(`Invalid command definition: ${id}`);
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
