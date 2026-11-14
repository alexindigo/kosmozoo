// src/backings/index.mjs — the backing registry: an address grammar → the
// driver that owns it. Two backings exist: comfy (host:port over HTTP) and
// folder (folder:/abs/path on disk). A backing knows its kind's I/O —
// { probe, list(kind), stat(name,kind), read(name,kind), write?, remove? } —
// so nothing outside drivers/ branches on the address grammar.

import * as comfy from "./comfy.mjs";
import * as folder from "./folder.mjs";
import { cancelled } from "./inventory.mjs";

export const FOLDER_RE = folder.FOLDER_RE;

export function isFolderHost(addr) {
  return FOLDER_RE.test(addr ?? "");
}

export function backingFor(addr) {
  return isFolderHost(addr) ? folder : comfy;
}

export { assertSafeName } from "./folder.mjs";
export { RENDERABLE, EXT_MIME } from "./mime.mjs";

// Validate at operation boundaries before cache, store or queue access. The
// local folder's existing basename-only grammar remains driver-owned.
export function validEntryName(addr, name) {
  return typeof name === "string" && name.length > 0 &&
    !name.includes("\0") &&
    (backingFor(addr).validName ?? folder.assertSafeName)(name);
}

export const createBindingFor = (addr, options) => backingFor(addr).createBinding(addr, options);

// The context injects its lifetime-bound transport once for every Comfy I/O
// path: routes, ingestion, feature writes and address-owned monitors alike.
export function withTransport(fetcher) {
  const driver = comfy.createDriver(fetcher);
  const select = addr => isFolderHost(addr) ? folder : driver;
  return { backingFor: select, createBindingFor: (addr, options) => select(addr).createBinding(addr, options) };
}

export function makeCollectionLifecycle(hosts, onRetire = () => {}) {
  const members = new Map(); let stopped = false;
  const reconcile = () => {
    for (const [id, token] of members) {
      if (hosts[id] !== token.address || token.registered && !(id in hosts)) { members.delete(id); onRetire(token); }
    }
    for (const id of Object.keys(hosts)) if (!members.has(id)) members.set(id,
      Object.freeze({ id, address: hosts[id], registered: true, incarnation: crypto.randomUUID() }));
  };
  reconcile();
  return {
    reconcile,
    capture(id) {
      if (stopped) return null;
      reconcile();
      if (!members.has(id)) members.set(id, Object.freeze({ id, address: hosts[id], registered: false, incarnation: crypto.randomUUID() }));
      return members.get(id);
    },
    isCurrent(token) {
      if (stopped || !token) return false;
      reconcile(); return members.get(token.id) === token && hosts[token.id] === token.address;
    },
    stop() { stopped = true; for (const token of members.values()) onRetire(token); members.clear(); },
  };
}

// Context/test rigs share this registry-owned address dispatcher and lifetime.
export function makeCollectionInventory(hosts, { bindingFactory = createBindingFor, onSnapshot = () => {}, onRetire = () => {} } = {}) {
  const bindings = new Map(), lifecycle = makeCollectionLifecycle(hosts, onRetire); let stopped = false;
  const accepted = new WeakMap();
  const binding = (address) => {
    if (stopped) throw cancelled("Address bindings stopped");
    if (!bindings.has(address)) bindings.set(address, bindingFactory(address));
    return bindings.get(address);
  };
  const inventory = async (id, options) => {
    const token = lifecycle.capture(id);
    if (!token?.address) throw cancelled("Unknown collection");
    const snapshot = await binding(token.address).inventory(options);
    if (!lifecycle.isCurrent(token)) throw cancelled();
    if (accepted.get(token) !== snapshot) {
      onSnapshot(id, token.address, snapshot, token);
      accepted.set(token, snapshot);
    }
    return snapshot;
  };
  inventory.binding = binding;
  inventory.capture = lifecycle.capture;
  inventory.isCurrent = lifecycle.isCurrent;
  inventory.accepted = token => lifecycle.isCurrent(token) ? accepted.get(token) ?? null : null;
  inventory.peek = (id) => bindings.get(hosts[id])?.peekInventory() ?? null;
  inventory.observeMetadata = async (id, name, { token = lifecycle.capture(id), ...options } = {}) => {
    if (!lifecycle.isCurrent(token) || !token.address) return { kind: "cancelled", status: 499 };
    const result = await binding(token.address).observeMetadata(name, options);
    return lifecycle.isCurrent(token) ? result : { kind: "cancelled", status: 499 };
  };
  inventory.reconcile = () => {
    lifecycle.reconcile();
    const addresses = new Set(Object.values(hosts));
    for (const [address, owner] of bindings) if (!addresses.has(address)) {
      owner.disposeInventory().catch(() => {}); bindings.delete(address);
    }
  };
  inventory.stop = async () => {
    stopped = true; lifecycle.stop();
    const pending = [...bindings.values()].map((owner) => owner.disposeInventory());
    bindings.clear(); await Promise.allSettled(pending);
  };
  return inventory;
}
