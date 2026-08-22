// src/ingest.mjs — image ingestion: read → hash → cache → index.
//
// Every image the engine touches flows through ingestion.  There is no
// "miss" path — bytes enter the local cache and the store is indexed
// before anything else sees them.

import { sha256, cachePut, cacheGet } from "./cache.mjs";
import { hostReadBytes } from "./hosts.mjs";

export class Ingest {
  #store;
  #hosts;

  constructor(store, hosts) {
    this.#store = store;
    this.#hosts = hosts;
  }

  // Ensure an image is cached and indexed.  Returns the hash on success,
  // or null if the host is unreachable.
  async ensure(host, filename) {
    const addr = this.#hosts[host];
    if (!addr) return null;

    // If already hashed and cached, skip the fetch.
    const existing = this.#store.hashFor(host, filename);
    if (existing && await cacheGet(existing) !== null) return existing;

    // Read from host.
    const r = await hostReadBytes(addr, filename);
    if (r.status !== 200) return null;
    const bytes = new Uint8Array(await new Response(r.body).arrayBuffer());
    return this.#ingestBytes(host, filename, bytes);
  }

  // Raw bytes path — the caller already has the bytes (folder host, direct read).
  async ensureBytes(host, filename, bytes) {
    return this.#ingestBytes(host, filename, bytes);
  }

  async #ingestBytes(host, filename, bytes) {
    const hash = await sha256(bytes);
    await cachePut(hash, bytes);
    await this.#store.ingestFile(host, filename, hash, bytes.length);
    return hash;
  }
}
