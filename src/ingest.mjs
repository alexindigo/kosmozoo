// src/ingest.mjs — the ONLY module that turns bytes into rows.
//
// One ingestion path: bytes → hash → cache → content (+extract when the
// content row's ext is stale) → entry. The prefetch walk is this path
// running ahead of the user; the bytes routes are this path running on
// demand. Revalidation is a method here (instance clock, no module globals).

import { sha256 } from "./cache.mjs";
import { backingFor } from "./backings/index.mjs";
import { metaFromPngBytes, imageDims, parsePngTextChunks, EXTRACTOR_VERSION } from "./extractor.mjs";

const DEFAULT_REVALIDATE_MS = 60_000;
// Dims live in the first bytes of the file: PNG IHDR at 16–24, GIF at 6–10,
// WebP VP8/VP8L/VP8X within the first 30, JPEG SOF usually within the first
// few KB — a 64 KB head covers the usual case; the full ingest is the
// fallback for the rest (§4.2).
const DIMS_HEAD_BYTES = 65_536;
// per-host cap on concurrent backing reads (the read gate below)
const MAX_INFLIGHT_PER_HOST = 4;

export class Ingest {
  #store;
  #hosts;
  #cache;
  #revalidateMs;
  #inflight = new Map(); // "<collection>\0<name>\0<kind>" -> flight (single-flight)
  #lastCheck = new Map(); // "in:?collection:name" -> ts (revalidation debounce)
  // the read gate: one lane per backing address, two classes. "high" is a
  // human waiting on this exact image (the bytes route); "low" is
  // background work (prefetch, revalidation). The next free slot always
  // goes to a high-class waiter — "the engine is busy" becomes latency on
  // background work, never an error on a user-visible image.
  #lanes = new Map(); // addr -> { high: [], low: [], inflight: 0 }

  constructor(store, hosts, { cache, revalidateMs = DEFAULT_REVALIDATE_MS }) {
    this.#store = store;
    this.#hosts = hosts;
    this.#cache = cache;
    this.#revalidateMs = revalidateMs;
  }

  #lane(addr) {
    let l = this.#lanes.get(addr);
    if (!l) {
      l = { high: [], low: [], inflight: 0 };
      this.#lanes.set(addr, l);
    }
    return l;
  }

  #pump(addr) {
    const l = this.#lane(addr);
    while (l.inflight < MAX_INFLIGHT_PER_HOST) {
      const job = l.high.shift() ?? l.low.shift();
      if (!job) return;
      l.inflight++;
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => {
          l.inflight--;
          this.#pump(addr);
        });
    }
  }

  // A backing read through the gate. `flight` (when given) lets a
  // high-priority caller joining an existing single-flight upgrade the
  // queued read from the low lane to the high lane.
  #readGated(addr, name, kind, opts, priority, flight = null) {
    const l = this.#lane(addr);
    return new Promise((resolve, reject) => {
      const job = { fn: () => backingFor(addr).read(addr, name, kind, opts), resolve, reject };
      l[priority].push(job);
      if (flight) {
        flight.upgrade = () => {
          const i = l.low.indexOf(job);
          if (i < 0) return; // already started (or already upgraded)
          l.low.splice(i, 1);
          l.high.push(job);
          flight.priority = "high";
          this.#pump(addr);
        };
      }
      this.#pump(addr);
    });
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

  // Dims WITHOUT ingestion ( pass 1): known dims (content via the
  // entry's hash, or the entry's own columns) short-circuit the read; else a
  // ranged head read → imageDims → stored on the entry. No hash, no cache
  // write, no extract. status 404 means the source lost the file (the
  // prefetch acts on it exactly like pass 2 would).
  async dims(collection, name, kind = "output") {
    const known = this.#store.entryDims(collection, name);
    if (known) return { status: 200, dims: known };
    const addr = this.#hosts[collection];
    if (!addr) return { status: 404, dims: null };
    const r = await this.#readGated(addr, name, kind, { range: [0, DIMS_HEAD_BYTES - 1] }, "low");
    if (r.status !== 200 && r.status !== 206) return { status: r.status, dims: null };
    const bytes = new Uint8Array(await new Response(r.body).arrayBuffer());
    const dims = imageDims(bytes);
    if (dims) this.#store.entryDimsPut(collection, name, dims);
    return { status: r.status, dims };
  }

  // Read-through: entry has a hash and the cache has the bytes → serve;
  // else read from the backing → ingest → serve. Single-flight per
  // (collection, name, kind): concurrent callers share one backing read.
  // priority: "high" = a human is waiting on this image (the bytes route) —
  // the read gate serves it before background work.
  // Resolves { hash, bytes, status: 200 } or { status } (backing said no).
  async ensure(collection, name, kind = "output", { priority = "low" } = {}) {
    // \0-separated: plain concatenation collides ("ab","c" vs "a","bc")
    const key = `${collection}\u0000${name}\u0000${kind}`;
    const existing = this.#inflight.get(key);
    if (existing) {
      if (priority === "high") existing.upgrade?.();
      return existing.promise;
    }
    const flight = { priority, promise: null, upgrade: null };
    const p = this.#ensureInner(collection, name, kind, flight)
      .finally(() => this.#inflight.delete(key));
    flight.promise = p;
    this.#inflight.set(key, flight);
    return p;
  }

  async #ensureInner(collection, name, kind, flight) {
    const addr = this.#hosts[collection];
    if (!addr) return { status: 404 };
    const info = kind === "input"
      ? this.#store.inputCacheGet(collection, name)
      : this.#store.fileInfo(collection, name);
    if (info?.hash && await this.#cache.has(info.hash)) {
      const bytes = await this.#cache.get(info.hash);
      if (bytes) return { hash: info.hash, bytes, status: 200 };
    }
    const r = await this.#readGated(addr, name, kind, undefined, flight.priority, flight);
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

  // The parsed embedded ComfyUI graph for cached bytes (null when absent or
  // invalid) — engine-side only (the variations feature's probe/run, plugins).
  async graph(hash) {
    const bytes = await this.#cache.get(hash);
    if (!bytes) return null;
    const chunks = await parsePngTextChunks(bytes);
    if (!chunks?.prompt) return null;
    try { return JSON.parse(chunks.prompt); } catch { return null; }
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

    const r = await this.#readGated(addr, name, input ? "input" : "output", undefined, "low");
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
