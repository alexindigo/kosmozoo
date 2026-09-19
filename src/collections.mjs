// src/collections.mjs — the collection registry + capabilities.
//
// Collections are user config: env seeds the table on first boot, then they
// are user-managed (POST/DELETE /api/collections). capabilities is the ONE
// function that answers "what can this collection do" for every consumer
// (GET /api/collections, DELETE entry, the client's delete affordance) —
// the deleteMode double-derivation (audit E2) dies here.
//
// Derived from the backing kind (+ the assets-plus probe for comfy):
// folder → unlink (permanent)
// comfy + trash → trash (recoverable via the assets_plus extension)
// comfy otherwise → hide (kosmozoo-side flag; ComfyUI has no delete API)

import { isFolderHost } from "./backings/index.mjs";
import { stat } from "node:fs/promises";
import { folderPath } from "./backings/folder.mjs";

export async function capabilities(collection, { online = true, useAssetsPlus = true, comfy = null } = {}) {
  const kind = collection.kind ?? (isFolderHost(collection.address) ? "folder" : "comfy");
  if (kind === "folder") {
    return { list: true, read: true, add: false, delete: "unlink", rename: false };
  }
  if (kind === "virtual") {
    // the schema slot only (future) — a virtual collection has no backing
    return { list: false, read: false, add: false, delete: false, rename: false };
  }
  const trash = online && useAssetsPlus && comfy != null && await comfy.hasAssetsPlus();
  return {
    list: true,
    read: true,
    add: true, // the upload endpoint exists (an offline host fails at POST time)
    delete: trash ? "trash" : "hide",
    rename: false,
  };
}

// --- the registry ------------------------------------------------------------

// KOZMOZOO_HOSTS: "name=host:port,name2=host2:port2" or "name=folder:/path"
export function parseHosts(env = Deno.env.toObject()) {
  const raw = env.KOZMOZOO_HOSTS ?? "local=127.0.0.1:8188";
  const hosts = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    hosts[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return hosts;
}

// Env seeds the collection table on first boot; afterwards the table wins.
// The returned object is the live { name: address } map — mutated in place
// so every holder (router ctx, prefetch) sees changes.
export async function loadCollections(store, env = Deno.env.toObject()) {
  const existing = store.collectionMap();
  if (Object.keys(existing).length) return existing;
  const seed = parseHosts(env);
  for (const [name, address] of Object.entries(seed)) store.collectionAdd(name, address);
  return store.collectionMap();
}

// Registry mutations persist to the collection table AND patch the live map.
export function addCollection(store, map, name, address) {
  store.collectionAdd(name, address);
  map[name] = address;
}

export function removeCollection(store, map, name) {
  store.collectionRemove(name);
  delete map[name];
}

const NAME_RE = /^[\w][\w.-]*$/;
const ADDR_RE = /^[\w.-]+:\d+$/;

// Validate a new collection: name grammar + address grammar; a folder
// collection must name an existing directory (spec ).
export async function validateCollection(name, address) {
  if (!name || !NAME_RE.test(name)) return "bad name (word chars, dots, hyphens)";
  if (address?.startsWith("folder:")) {
    const path = folderPath(address);
    if (!path?.trim()) return "folder: needs a path";
    try {
      const s = await stat(path);
      if (!s.isDirectory()) return `folder: not a directory: ${path}`;
    } catch {
      return `folder: not readable: ${path}`;
    }
    return null;
  }
  if (!address || !ADDR_RE.test(address)) return "bad address (host:port or folder:/path)";
  return null;
}

// `collection:name` identity grammar (legacy judgment keys, variations ids).
export function splitHostKey(key) {
  const i = key.indexOf(":");
  return [key.slice(0, i), key.slice(i + 1)];
}
