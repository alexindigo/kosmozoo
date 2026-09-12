// src/cache.mjs — the hash-addressed local cache of image bytes.
//
// Every image the engine serves gets its bytes stored here, keyed by
// SHA-256. Once cached, a busy host is no longer a read outage — bytes
// serve from local disk.
//
// Layout: <root>/<ab>/<hash> — extension-less; the mime is content-sniffed
// at serve time, never trusted from a filename. Writes: atomic (tmp →
// rename) — a corrupt write never poisons an image.
//
// The root is INJECTED (context owns it); there are no module globals.

import { join, dirname } from "node:path";
import { mkdir, rename, writeFile, readFile, stat } from "node:fs/promises";

export class Cache {
  #root;

  constructor(root) {
    this.#root = root;
  }

  get root() {
    return this.#root;
  }

  path(hash) {
    return join(this.#root, hash.slice(0, 2), hash);
  }

  async put(hash, bytes) {
    const path = this.path(hash);
    await mkdir(dirname(path), { recursive: true });
    const tmp = path + ".tmp." + crypto.randomUUID();
    await writeFile(tmp, bytes);
    await rename(tmp, path);
  }

  async get(hash) {
    try {
      return await readFile(this.path(hash));
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }

  async has(hash) {
    try {
      const s = await stat(this.path(hash));
      return s.isFile();
    } catch {
      return false;
    }
  }
}

// --- hash computation ---------------------------------------------------------

export async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
