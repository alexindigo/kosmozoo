// src/cache.mjs — hash-addressed local cache of rendered image bytes.
//
// Every image the engine serves gets its bytes stored here, keyed by
// SHA-256.  Once cached, a host being busy training is no longer a read
// outage — bytes serve from the local disk.
//
// Layout:  ~/.local/share/kosmozoo/cache/<ab>/<hash>.png
// Override: KOZMOZOO_CACHE
// Writes:   atomic (tmp → rename) — a corrupt write never poisons an image.

import { join, dirname } from "node:path";
import { mkdir, rename, writeFile, readFile } from "node:fs/promises";

const DEFAULT_ROOT = join(
  Deno.env.get("HOME") ?? "/tmp",
  ".local", "share", "kosmozoo", "cache",
);

let root;

export function cacheRoot() {
  if (root) return root;
  root = Deno.env.get("KOZMOZOO_CACHE") ?? DEFAULT_ROOT;
  return root;
}

export function cachePath(hash) {
  const ab = hash.slice(0, 2);
  return join(cacheRoot(), ab, `${hash}.png`);
}

export async function cachePut(hash, bytes) {
  const path = cachePath(hash);
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + ".tmp." + crypto.randomUUID();
  await writeFile(tmp, bytes);
  await rename(tmp, path);
}

export async function cacheGet(hash) {
  try {
    return await readFile(cachePath(hash));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

export async function cacheHas(hash) {
  try {
    const { stat } = await import("node:fs/promises");
    const s = await stat(cachePath(hash));
    return s.isFile();
  } catch {
    return false;
  }
}

// --- hash computation ---------------------------------------------------------

export async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
