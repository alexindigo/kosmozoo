// src/ingest.mjs — the ONLY module that turns bytes into rows.
//
// One ingestion path: bytes → hash → cache → content (+extract when the
// content row's ext is stale) → entry. The prefetch walk is this path
// running ahead of the user; the bytes routes are this path running on
// demand. Revalidation is a method here (instance clock, no module globals).

import { sha256 } from "./cache.mjs";
import { backingFor } from "./backings/index.mjs";
import { metaFromPngBytes, imageDims, EXTRACTOR_VERSION } from "./extractor.mjs";

const DEFAULT_REVALIDATE_MS = 60_000;

export class Ingest {
  #store;
  #hosts;
  #cache;
  #revalidateMs;
  #inflight = new Map(); // "collection:name:kind" -> Promise (single-flight)
  #lastCheck = new Map(); // "in:?collection:name" -> ts (revalidation debounce)

  constructor(store, hosts, { cache, revalidateMs = DEFAULT_REVALIDATE_MS }) {
    this.#store = store;
    this.#hosts = hosts;
    this.#cache = cache;
    this.#revalidateMs = revalidateMs;
  }

  // bytes → hash → cache → content (+extract when stale) → entry. Returns
  // the hash. `kind` is 'output' (extracted) or 'input' (never extracted).
  async ingest(collection, name, kind, { bytes, stamp = null }) {
    const hash = await sha256(bytes);
    await this.#cache.put(hash, bytes);
    if (kind === "input") {
      this.#store.inputCachePut(collection, name, hash, stamp);
      return hash;
    }
    const before = this.#store.fileInfo(collection, name);
    const dims = imageDims(bytes);
    await this.#store.ingestFile(collection, name, hash, bytes.length, {
      stamp,
      changed: !!before?.hash && before.hash !== hash,
      dims,
    });
    await this.#extractIfStale(collection, name, bytes);
    return hash;
  }

  // Extraction staleness is decided HERE and only here.
  async #extractIfStale(collection, name, bytes) {
    const hash = this.#store.hashFor(collection, name);
    const cur = hash ? this.#store.contentGet(hash) : null;
    if (cur && cur.ext >= EXTRACTOR_VERSION) return;
    const [meta, hasWorkflow] = await metaFromPngBytes(bytes);
    await this.#store.metaPut(collection, name, meta, { hasWorkflow, ext: EXTRACTOR_VERSION });
  }

  // Read-through: entry has a hash and the cache has the bytes → serve;
  // else read from the backing → ingest → serve. Single-flight per
  // (collection, name, kind): concurrent callers share one backing read.
  // Resolves { hash, bytes, status: 200 } or { status } (backing said no).
  async ensure(collection, name, kind = "output") {
    const key = `${collection}${name}${kind}`;
    if (this.#inflight.has(key)) return this.#inflight.get(key);
    const p = this.#ensureInner(collection, name, kind)
      .finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, p);
    return p;
  }

  async #ensureInner(collection, name, kind) {
    const addr = this.#hosts[collection];
    if (!addr) return { status: 404 };
    const info = kind === "input"
      ? this.#store.inputCacheGet(collection, name)
      : this.#store.fileInfo(collection, name);
    if (info?.hash && await this.#cache.has(info.hash)) {
      const bytes = await this.#cache.get(info.hash);
      if (bytes) return { hash: info.hash, bytes, status: 200 };
    }
    const r = await backingFor(addr).read(addr, name, kind);
    if (r.status !== 200) return { status: r.status };
    const bytes = new Uint8Array(await new Response(r.body).arrayBuffer());
    const stamp = (await backingFor(addr).stat(addr, name, kind))?.stamp ?? null;
    const hash = await this.ingest(collection, name, kind, { bytes, stamp });
    return { hash, bytes, status: 200 };
  }

  // Raw-bytes path — the caller already has them (upload proxy, tests).
  async ensureBytes(collection, name, bytes, { kind = "output", stamp = null } = {}) {
    return this.ingest(collection, name, kind, { bytes, stamp });
  }

  // --- revalidation (stale-while-revalidate over every backing kind) ---------
  //
  // Bytes ALWAYS serve from the cache — a request never waits on the source.
  // At most once per revalidateMs per file a request fires an async stamp
  // check; a change remaps the entry to the new content's hash (meta and
  // judgments follow the hash, so the new content starts clean and the old
  // keeps its history).

  scheduleRevalidate(collection, name, { input = false } = {}) {
    if (!this.#hosts[collection]) return;
    const key = `${input ? "in:" : ""}${collection}:${name}`;
    const now = Date.now();
    if (now - (this.#lastCheck.get(key) ?? 0) < this.#revalidateMs) return;
    this.#lastCheck.set(key, now);
    this.revalidateNow(collection, name, { input }).catch(() => {});
  }

  // Exported for tests and the scheduler: compare the source stamp against
  // the recorded one; on mismatch re-read and remap. Same content with a
  // newer stamp (a touch) only refreshes the stamp.
  async revalidateNow(collection, name, { input = false } = {}) {
    const addr = this.#hosts[collection];
    if (!addr) return;
    const stamp = (await backingFor(addr).stat(addr, name, input ? "input" : "output"))?.stamp ?? null;
    if (stamp == null) return; // gone/unreachable — keep what we have

    const info = input
      ? this.#store.inputCacheGet(collection, name)
      : this.#store.fileInfo(collection, name);
    if (!info) return;
    if (info.stamp != null && stamp === info.stamp) return; // unchanged

    const r = await backingFor(addr).read(addr, name, input ? "input" : "output");
    if (r.status !== 200) return; // unreadable right now — keep what we have
    const bytes = new Uint8Array(await new Response(r.body).arrayBuffer());
    const hash = await sha256(bytes);
    if (!input && info.hash === hash) {
      this.#store.touchFileStamp(collection, name, stamp); // touch only
      return;
    }
    await this.ingest(collection, name, input ? "input" : "output", { bytes, stamp });
  }
}
