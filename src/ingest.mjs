// src/ingest.mjs — the ONLY module that turns bytes into rows.
//
// One ingestion path: bytes → hash → cache → content (+extract when the
// content row's ext is stale) → entry. The prefetch walk is this path
// running ahead of the user; the bytes routes are this path running on
// demand. Revalidation is a method here (instance clock, no module globals).

import { sha256 } from "./cache.mjs";
import { backingFor as defaultBackingFor, validEntryName, makeCollectionLifecycle } from "./backings/index.mjs";
import { cancelled } from "./backings/inventory.mjs";
import { metaFromBytes, imageDims, EXTRACTOR_VERSION } from "./extractor.mjs";
import { isResourceRoot } from "./parameters.mjs";

const DEFAULT_REVALIDATE_MS = 60_000;
// Dims live in the first bytes of the file: PNG IHDR at 16–24, GIF at 6–10,
// WebP VP8/VP8L/VP8X within the first 30, JPEG SOF usually within the first
// few KB — a 64 KB head covers the usual case; the full ingest is the
// fallback for the rest (§4.2).
const DIMS_HEAD_BYTES = 65_536;
// per-host cap on concurrent backing reads (the read gate below)
const MAX_INFLIGHT_PER_HOST = 4;
const MAX_BACKGROUND_PER_HOST = MAX_INFLIGHT_PER_HOST - 1;

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
  // goes to a high-class waiter; low bodies cannot occupy the fourth slot.
  // "the engine is busy" becomes latency on
  // background work, never an error on a user-visible image.
  #lanes = new Map(); // addr -> { high: [], low: [], inflight: 0 }
  #capture;
  #isCurrent;
  #backingFor;
  #lifetime;

  constructor(store, hosts, { cache, revalidateMs = DEFAULT_REVALIDATE_MS, capture, isCurrent, backingFor = defaultBackingFor, lifetime }) {
    this.#store = store;
    this.#hosts = hosts;
    this.#cache = cache;
    this.#revalidateMs = revalidateMs;
    const lifecycle = capture && isCurrent ? null : makeCollectionLifecycle(hosts);
    this.#capture = capture ?? lifecycle.capture;
    const current = isCurrent ?? lifecycle.isCurrent;
    this.#isCurrent = token => !lifetime?.signal.aborted && current(token);
    this.#backingFor = backingFor;
    this.#lifetime = lifetime;
  }

  #assertCurrent(token) { if (!this.#isCurrent(token)) throw cancelled(); }
  #cancelled() { return { status: 499, cancelled: true }; }

  #lane(addr) {
    let l = this.#lanes.get(addr);
    if (!l) {
      l = { high: [], low: [], inflight: 0, background: 0 };
      this.#lanes.set(addr, l);
    }
    return l;
  }

  #pump(addr) {
    const l = this.#lane(addr);
    while (l.inflight < MAX_INFLIGHT_PER_HOST) {
      const job = l.high.shift() ?? (l.background < MAX_BACKGROUND_PER_HOST ? l.low.shift() : null);
      if (!job) return;
      l.inflight++;
      const background = job.priority === "low";
      if (background) l.background++;
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => {
          l.inflight--;
          if (background) l.background--;
          this.#pump(addr);
        });
    }
  }

  // A backing read through the gate. `flight` (when given) lets a
  // high-priority caller joining an existing single-flight upgrade the
  // queued read from the low lane to the high lane.
  #readGated(addr, name, kind, opts, priority, flight = null, token = null) {
    const l = this.#lane(addr);
    return new Promise((resolve, reject) => {
      const job = { priority, resolve, reject, fn: async () => {
        if (token && !this.#isCurrent(token)) return this.#cancelled();
        const reply = await this.#backingFor(addr).read(addr, name, kind, opts);
        // The slot owns the body too: response headers do not complete a
        // backing read. All read paths consume through this same gate.
        const bytes = new Uint8Array(await new Response(reply.body).arrayBuffer());
        return { ...reply, bytes };
      } };
      l[priority].push(job);
      if (flight) {
        flight.upgrade = () => {
          const i = l.low.indexOf(job);
          if (i < 0) return; // already started (or already upgraded)
          l.low.splice(i, 1);
          job.priority = "high";
          l.high.push(job);
          flight.priority = "high";
          this.#pump(addr);
        };
      }
      this.#pump(addr);
    });
  }

  // bytes → hash → cache → content (+extract when stale) → entry. Returns
  // the hash. `kind` is the resource root: 'output' entries are inventory/
  // extraction owners; 'input'/'temp' are root-keyed cache rows, never extracted.
  async ingest(collection, name, kind, { bytes, stamp = null, token = this.#capture(collection) }) {
    if (!isResourceRoot(kind)) throw new TypeError(`unknown resource root: ${kind}`);
    this.#assertCurrent(token);
    if (!validEntryName(token.address, name)) throw new TypeError("bad entry path");
    const hash = await sha256(bytes);
    this.#assertCurrent(token);
    await this.#cache.put(hash, bytes);
    this.#assertCurrent(token);
    const dims = imageDims(bytes);
    if (kind !== "output") {
      this.#store.resourceCachePut(collection, name, kind, hash, stamp, bytes.length, dims);
      return hash;
    }
    const before = this.#store.fileInfo(collection, name);
    await this.#store.ingestFile(collection, name, hash, bytes.length, {
      stamp,
      changed: !!before?.hash && before.hash !== hash,
      dims,
    });
    await this.#extractIfStale(collection, name, bytes, token);
    return hash;
  }

  // Extraction staleness is decided HERE and only here.
  async #extractIfStale(collection, name, bytes, token) {
    this.#assertCurrent(token);
    const hash = this.#store.hashFor(collection, name);
    const cur = hash ? this.#store.contentGet(hash) : null;
    if (cur && cur.ext >= EXTRACTOR_VERSION) return;
    const [meta, hasWorkflow] = await metaFromBytes(bytes, name);
    this.#assertCurrent(token);
    await this.#store.metaPut(collection, name, meta, { hasWorkflow, ext: EXTRACTOR_VERSION });
  }

  // Dims without full ingestion (pass 1): hash-bound facts short-circuit or
  // recover from that hash's cache. Only hashless entries use provisional
  // ranged heads. No upstream full ingest, cache write or extraction.
  // status 404 means the source lost the file (the
  // prefetch acts on it exactly like pass 2 would).
  dims(collection, name, kind = "output", options = {}) {
    const run = () => this.#dims(collection, name, kind, options);
    return this.#lifetime ? this.#lifetime.run(`dimensions ${collection}/${name}`, run) : run();
  }

  async #dims(collection, name, kind, { priority = "low" } = {}) {
    if (!isResourceRoot(kind)) return { status: 400, dims: null };
    const token = this.#capture(collection), addr = token?.address;
    if (!token || !this.#isCurrent(token)) return { ...this.#cancelled(), dims: null };
    if (!validEntryName(addr, name)) return { status: 400, dims: null };
    const known = this.#store.entryDims(collection, name, kind);
    if (known) return { status: 200, dims: known };
    const hash = this.#recorded(collection, name, kind)?.hash;
    if (hash) {
      // A mutable named head cannot say anything about already-hashed bytes.
      // Dimension-only interest recovers only from that exact cache object.
      const bytes = await this.#cache.get(hash);
      if (!this.#isCurrent(token)) return { ...this.#cancelled(), dims: null };
      if (this.#recorded(collection, name, kind)?.hash === hash && bytes) {
        this.#store.contentDimsPut(hash, imageDims(bytes));
      }
      return { status: 200, dims: this.#store.entryDims(collection, name, kind) };
    }
    if (!addr) return { status: 404, dims: null };
    const r = await this.#readGated(addr, name, kind, { range: [0, DIMS_HEAD_BYTES - 1] }, priority, null, token);
    if (!this.#isCurrent(token)) return { ...this.#cancelled(), dims: null };
    // Full ingestion may have won while this provisional read held its body.
    if (this.#recorded(collection, name, kind)?.hash) {
      return { status: 200, dims: this.#store.entryDims(collection, name, kind) };
    }
    if (r.status !== 200 && r.status !== 206) return { status: r.status, dims: null };
    const bytes = r.bytes;
    if (!this.#isCurrent(token)) return { ...this.#cancelled(), dims: null };
    const dims = imageDims(bytes);
    if (dims) this.#store.entryDimsPut(collection, name, dims, kind);
    return { status: r.status, dims };
  }

  // Read-through: entry has a hash and the cache has the bytes → serve;
  // else read from the backing → ingest → serve. Single-flight per
  // (collection, name, kind): concurrent callers share one backing read.
  // priority: "high" = a human is waiting on this image (the bytes route) —
  // the read gate serves it before background work.
  // Resolves { hash, bytes, status: 200 } or { status } (backing said no).
  async ensure(collection, name, kind = "output", { priority = "low" } = {}) {
    if (!isResourceRoot(kind)) return { status: 400 };
    const token = this.#capture(collection);
    if (!token || !this.#isCurrent(token)) return this.#cancelled();
    if (!validEntryName(token?.address, name)) return { status: 400 };
    // \0-separated: plain concatenation collides ("ab","c" vs "a","bc")
    const key = `${token.incarnation}\u0000${collection}\u0000${name}\u0000${kind}`;
    const existing = this.#inflight.get(key);
    if (existing) {
      if (priority === "high") existing.upgrade?.();
      return existing.promise;
    }
    const flight = { priority, promise: null, upgrade: null, token };
    const run = () => this.#ensureInner(collection, name, kind, flight);
    const p = (this.#lifetime ? this.#lifetime.run(`ingest ${collection}/${name}`, run) : run())
      .catch((error) => { if (error.code === "cancelled") return this.#cancelled(); throw error; })
      .finally(() => this.#inflight.delete(key));
    flight.promise = p;
    this.#inflight.set(key, flight);
    return p;
  }

  async #ensureInner(collection, name, kind, flight) {
    const token = flight.token, addr = token.address;
    if (!addr) return { status: 404 };
    const info = this.#recorded(collection, name, kind);
    if (info?.hash && await this.#cache.has(info.hash)) {
      if (!this.#isCurrent(token)) return this.#cancelled();
      const bytes = await this.#cache.get(info.hash);
      if (!this.#isCurrent(token)) return this.#cancelled();
      if (bytes) return { hash: info.hash, bytes, status: 200 };
    }
    const r = await this.#readGated(addr, name, kind, undefined, flight.priority, flight, token);
    if (!this.#isCurrent(token)) return this.#cancelled();
    if (r.status !== 200) return { status: r.status };
    const bytes = r.bytes;
    if (!this.#isCurrent(token)) return this.#cancelled();
    const stamp = (await this.#backingFor(addr).stat(addr, name, kind))?.stamp ?? null;
    if (!this.#isCurrent(token)) return this.#cancelled();
    const hash = await this.ingest(collection, name, kind, { bytes, stamp, token });
    if (!this.#isCurrent(token)) return this.#cancelled();
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
    const [, , graph] = await metaFromBytes(bytes);
    return graph;
  }

  // --- revalidation (stale-while-revalidate over every backing kind) ---------
  //
  // Bytes ALWAYS serve from the cache — a request never waits on the source.
  // At most once per revalidateMs per file a request fires an async stamp
  // check; a change remaps the entry to the new content's hash (meta and
  // judgments follow the hash, so the new content starts clean and the old
  // keeps its history).

  // `kind` names the root; the `input` boolean remains a compatibility facade.
  scheduleRevalidate(collection, name, { input = false, kind = input ? "input" : "output" } = {}) {
    if (!isResourceRoot(kind)) return;
    if (!this.#hosts[collection]) return;
    if (!validEntryName(this.#hosts[collection], name)) return;
    const token = this.#capture(collection);
    const key = `${token.incarnation}\u0000${kind}\u0000${collection}:${name}`;
    const now = Date.now();
    if (now - (this.#lastCheck.get(key) ?? 0) < this.#revalidateMs) return;
    this.#lastCheck.set(key, now);
    this.revalidateNow(collection, name, { kind, token }).catch(() => {});
  }

  // The recorded hash/stamp for one resource root (output: the inventory entry).
  #recorded(collection, name, kind) {
    return kind === "output" ? this.#store.fileInfo(collection, name) : this.#store.resourceCacheGet(collection, name, kind);
  }

  // Exported for tests and the scheduler: compare the source stamp against
  // the recorded one; on mismatch re-read and remap. Same content with a
  // newer stamp (a touch) only refreshes the stamp.
  revalidateNow(collection, name, options = {}) {
    const run = () => this.#revalidateNow(collection, name, options);
    return this.#lifetime ? this.#lifetime.run(`revalidate ${collection}/${name}`, run) : run();
  }

  async #revalidateNow(collection, name, { input = false, kind = input ? "input" : "output", token = this.#capture(collection) } = {}) {
    if (!isResourceRoot(kind)) throw new TypeError(`unknown resource root: ${kind}`);
    if (!this.#isCurrent(token)) return this.#cancelled();
    const addr = token?.address;
    if (!addr) return;
    if (!validEntryName(addr, name)) return;
    const stamp = (await this.#backingFor(addr).stat(addr, name, kind))?.stamp ?? null;
    if (!this.#isCurrent(token)) return this.#cancelled();
    if (stamp == null) return; // gone/unreachable — keep what we have

    const info = this.#recorded(collection, name, kind);
    if (!info) return;
    if (info.stamp != null && stamp === info.stamp) return; // unchanged

    const r = await this.#readGated(addr, name, kind, undefined, "low", null, token);
    if (!this.#isCurrent(token)) return this.#cancelled();
    if (r.status !== 200) return; // unreadable right now — keep what we have
    const bytes = r.bytes;
    const hash = await sha256(bytes);
    if (!this.#isCurrent(token)) return this.#cancelled();
    if (kind === "output" && info.hash === hash) {
      this.#store.touchFileStamp(collection, name, stamp); // touch only
      return;
    }
    await this.ingest(collection, name, kind, { bytes, stamp, token });
  }
}
