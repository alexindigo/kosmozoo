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
    return { list: true, read: true, add: false, delete: "unlink", rename: false,
      subfolders: { supported: false, reason: "Local folder sources are flat; output root only" } };
  }
  if (kind === "virtual") {
    // the schema slot only (future) — a virtual collection has no backing
    return { list: false, read: false, add: false, delete: false, rename: false };
  }
  const trash = online && useAssetsPlus && comfy != null && await comfy.hasAssetsPlus();
  const subfolders = comfy?.subfolders
    ? await comfy.subfolders()
    : { supported: null, reason: "Recursive inventory support has not been discovered" };
  return {
    list: true,
    read: true,
    add: true, // the upload endpoint exists (an offline host fails at POST time)
    delete: trash ? "trash" : "hide",
    rename: false,
    subfolders,
  };
}

// --- the registry ------------------------------------------------------------

// KOZMOZOO_HOSTS: "name=host[:port],name2=host2[:port2]" or "name=folder:/path"
export function parseHosts(env = Deno.env.toObject()) {
  const raw = env.KOZMOZOO_HOSTS ?? "";
  if (!raw.trim()) return {};
  const hosts = [];
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq < 0) throw new Error(`KOZMOZOO_HOSTS: expected name=address: ${pair}`);
    const name = pair.slice(0, eq).trim();
    const normalized = normalizeAddress(pair.slice(eq + 1).trim());
    const error = validateName(name) ?? normalized.error;
    if (error) throw new Error(`KOZMOZOO_HOSTS: ${JSON.stringify(name)}: ${error}`);
    hosts.push([name, normalized.address]);
  }
  return Object.fromEntries(hosts);
}

// Env seeds the collection table on first boot; afterwards the table wins.
// The returned object is the live { name: address } map — mutated in place
// so every holder (router ctx, prefetch) sees changes.
export async function loadCollections(store, env = Deno.env.toObject()) {
  const existing = store.collectionMap();
  if (Object.keys(existing).length) return existing;
  const seed = parseHosts(env);
  // Validate the complete seed (including folder IO) before the first write.
  for (const [name, address] of Object.entries(seed)) {
    const error = await validateCollection(name, address);
    if (error) throw new Error(`KOZMOZOO_HOSTS: ${JSON.stringify(name)}: ${error}`);
  }
  for (const [name, address] of Object.entries(seed)) store.collectionAdd(name, address);
  return store.collectionMap();
}

const NAME_RE = /^[\w][\w.-]*$/;
const ADDR_RE = /^[\w.-]+(?::(\d+))?$/;
const validateName = name => typeof name === "string" && NAME_RE.test(name)
  ? null : "bad name (word chars, dots, hyphens)";

// The single address grammar/normalization owner. Folder existence stays at
// the async collection admission boundary; canonical HTTP addresses are what
// persistence, conflict checks and every downstream address consumer receive.
export function normalizeAddress(address) {
  if (typeof address === "string") {
    if (address.startsWith("folder:")) return { address };
    const match = ADDR_RE.exec(address);
    if (match && (match[1] === undefined || (Number(match[1]) >= 1 && Number(match[1]) <= 65535))) {
      return { address: match[1] === undefined ? `${address}:80` : address };
    }
  }
  return { error: "bad address (host[:port] or folder:/path; HTTP port 1–65535, default 80)" };
}

// Source attributes have their own persistence boundary: no address/folder
// validation or host probing for an edit to an existing source.
export function validateAttributes(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return "source attributes must be an object";
  for (const [key, value] of Object.entries(patch)) {
    if (key !== "pinned" && key !== "autoRefresh") return `unknown source attribute: ${key}`;
    if (typeof value !== "boolean") return `${key} must be a boolean`;
  }
  return null;
}

export const sourceAttributes = (record) => ({ pinned: !!record.pinned, autoRefresh: !!record.auto_refresh });

// Validate a new collection: name grammar + address grammar; a folder
// collection must name an existing directory (spec ).
export async function validateCollection(name, address) {
  const normalized = normalizeAddress(address);
  const error = validateName(name) ?? normalized.error;
  if (error) return error;
  if (normalized.address.startsWith("folder:")) {
    const path = folderPath(normalized.address);
    if (!path?.trim()) return "folder: needs a path";
    try {
      const s = await stat(path);
      if (!s.isDirectory()) return `folder: not a directory: ${path}`;
    } catch {
      return `folder: not readable: ${path}`;
    }
    return null;
  }
  return null;
}

// `collection:name` identity grammar (legacy judgment keys, variations ids).
export function splitHostKey(key) {
  const i = key.indexOf(":");
  return [key.slice(0, i), key.slice(i + 1)];
}
