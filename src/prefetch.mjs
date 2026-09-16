// src/prefetch.mjs — the ingestion path running ahead of the user.
//
// ONE async worker per collection (each with its own inter-file delay and
// backoff sleep): pass 1 reads 64 KB dims heads (cheap, ~100 entries/s) so
// every entry carries width/height before ingest; pass 2 calls ingest.ensure
// (bytes → hash → cache → content → entry) at the existing politeness. The
// dims queue drains before ingestion starts. A worker's failure is logged
// and surfaced as its lastError on /api/prefetch; an unexpected rejection
// never kills the worker — it restarts after MAX_BACKOFF, so one host's
// outage never stalls another.
// Politeness set (spec harvest #8): single-flight per collection, a small
// inter-file gap, backoff capped at 30 s, 404 ⇒ entry.state='gone'
// (permanent), two-tier queues where on-screen priority actually promotes
// (in BOTH passes), pause gate.
// Must run headless — ingestion never requires an open browser.

import { EXTRACTOR_VERSION } from "./extractor.mjs";
import { backingFor } from "./backings/index.mjs";

const INTER_FILE_DELAY = 100;      // ms between ingest reads (pass 2)
const DIMS_INTER_FILE_DELAY = 10;  // ms between head reads (pass 1 — 64 KB is cheap)
const MAX_BACKOFF = 30_000;     // backoff cap
const LIST_REFRESH_MS = 60_000; // re-list each collection at most this often
const IDLE_MS = 1000;           // re-check cadence when a worker has nothing to do

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Prefetch {
  // hosts: { name: "host:port" }; enabled/paused come from settings.
  constructor({ hosts, store, settings, ingest, interFileDelayMs = INTER_FILE_DELAY, dimsInterFileDelayMs = DIMS_INTER_FILE_DELAY, listRefreshMs = LIST_REFRESH_MS }) {
    this.hosts = hosts;
    this.store = store;
    this.settings = settings;
    this.ingest = ingest;
    this.interFileDelayMs = interFileDelayMs;
    this.dimsInterFileDelayMs = dimsInterFileDelayMs;
    this.listRefreshMs = listRefreshMs;
    // collection -> { dimsPrio, dimsPrioSet, dimsWalk, dimsWalkSet, dimsInflight,
    //                 prio, prioSet, walk, walkSet, inflight, errors, task, lastError }
    this.workers = new Map();
    this.running = false;
  }

  #lastList = new Map(); // collection -> ts
  // collection -> Set of names whose head read yielded no dims. In-memory
  // only: a listing refresh must not re-read them every round, and the full
  // ingest derives dims from the complete bytes anyway (the pass-2 fallback).
  #dimsTried = new Map();

  #w(collection) {
    if (!this.workers.has(collection)) {
      this.workers.set(collection, {
        dimsPrio: [], dimsPrioSet: new Set(), dimsWalk: [], dimsWalkSet: new Set(), dimsInflight: null,
        prio: [], prioSet: new Set(), walk: [], walkSet: new Set(), inflight: null,
        errors: 0, task: null, lastError: null,
      });
    }
    return this.workers.get(collection);
  }

  #tried(collection) {
    let s = this.#dimsTried.get(collection);
    if (!s) { s = new Set(); this.#dimsTried.set(collection, s); }
    return s;
  }

  #log(collection, e) {
    const w = this.#w(collection);
    w.lastError = e?.message ?? String(e);
    console.warn(`prefetch [${collection}]: ${w.lastError}`);
  }

  lastError(collection) {
    return this.workers.get(collection)?.lastError ?? null;
  }

  pending(collection) {
    const w = this.workers.get(collection);
    if (!w) return 0;
    return w.prio.length + w.walk.length + (w.inflight ? 1 : 0);
  }

  dimsPending(collection) {
    const w = this.workers.get(collection);
    if (!w) return 0;
    return w.dimsPrio.length + w.dimsWalk.length + (w.dimsInflight ? 1 : 0);
  }

  // Queue names whose dims are unknown (pass 1) or whose meta is unknown or
  // stale (pass 2). priority=true promotes in BOTH queues: already prio'd is
  // skipped; sitting in a walk lane MOVES to the prio lane (want actually
  // promotes — E12).
  feed(collection, names, priority = false) {
    if (!names?.length) return this.pending(collection);
    const fresh = this.store.metaFresh(collection, EXTRACTOR_VERSION);
    const dimmed = this.store.dimsKnown(collection);
    const tried = this.#tried(collection);
    const w = this.#w(collection);
    // a collection added at runtime gets its worker on the first feed
    if (this.running && !w.task) w.task = this.#runCollection(collection);
    for (const name of names) {
      if (!dimmed.has(name) && !tried.has(name) && !w.dimsPrioSet.has(name)) {
        if (priority) {
          if (w.dimsWalkSet.delete(name)) w.dimsWalk = w.dimsWalk.filter((n) => n !== name);
          w.dimsPrio.push(name); w.dimsPrioSet.add(name);
        } else if (!w.dimsWalkSet.has(name)) {
          w.dimsWalk.push(name); w.dimsWalkSet.add(name);
        }
      }
      if (fresh.has(name) || w.prioSet.has(name)) continue;
      if (priority) {
        if (w.walkSet.delete(name)) w.walk = w.walk.filter((n) => n !== name);
        w.prio.push(name); w.prioSet.add(name);
      } else if (!w.walkSet.has(name)) {
        w.walk.push(name); w.walkSet.add(name);
      }
    }
    return this.pending(collection);
  }

  async start() {
    if (this.running) return;
    this.running = true;
    for (const id of Object.keys(this.hosts)) {
      const w = this.#w(id);
      w.task = this.#runCollection(id);
    }
  }

  // One worker per collection: its listing refresh, inter-file gaps and
  // backoff sleeps never touch another collection's lane. A collection
  // removed from the hosts map ends its worker — and the worker's whole
  // state dies with it, so a re-added collection starts clean (its feed
  // spawns a fresh worker: a settled task must not look like a live one).
  async #runCollection(collection) {
    try {
      while (this.running && collection in this.hosts) {
        try {
          if (!(await this.#step(collection))) await sleep(IDLE_MS);
        } catch (e) {
          // a worker must never die: log + report, restart after the cap
          this.#log(collection, e);
          await this.#sleepUntil(MAX_BACKOFF);
        }
      }
    } finally {
      const w = this.workers.get(collection);
      if (w) w.task = null;
      if (!(collection in this.hosts)) {
        this.workers.delete(collection);
        this.#dimsTried.delete(collection);
        this.#lastList.delete(collection);
      }
    }
  }

  // Process one item (or refresh the listing). Returns false when there was
  // nothing to do.
  async #step(collection) {
    const enabled = this.settings.get("core.prefetch", "enabled", true);
    const paused = this.settings.get("core.prefetch", "paused", false);

    // the walk lane is fed by listing each collection (the listing route has
    // no side effects — E3) at most once per refresh
    const last = this.#lastList.get(collection) ?? 0;
    if (Date.now() - last > this.listRefreshMs) {
      this.#lastList.set(collection, Date.now());
      try {
        const listing = await backingFor(this.hosts[collection]).list(this.hosts[collection]);
        this.feed(collection, listing.map((f) => f.name ?? f));
      } catch (e) {
        // listing failed this round — the walk retries next tick
        this.#log(collection, e);
      }
    }

    const w = this.#w(collection);
    if (!w || w.inflight || w.dimsInflight) return false;

    // pass 1 (dims) drains before pass 2 (ingest) starts; want promotes
    // within each pass. peek — never demote a prio item when paused (E13)
    let name = null, lane = null;
    if (w.dimsPrio.length) { name = w.dimsPrio[0]; lane = "dimsPrio"; }
    else if (enabled && w.dimsWalk.length) { name = w.dimsWalk[0]; lane = "dimsWalk"; }
    else if (w.prio.length) { name = w.prio[0]; lane = "prio"; }
    else if (enabled && w.walk.length) { name = w.walk[0]; lane = "walk"; }
    if (name === null || paused) return false;

    if (lane === "dimsPrio" || lane === "dimsWalk") {
      w.dimsInflight = name;
      try {
        const r = await this.ingest.dims(collection, name);
        if (r.status === 404) {
          // gone from the source — the same signal pass 2 acts on (C5),
          // observed one pass earlier
          await this.store.entryGone(collection, name);
        }
        if (!r.dims) this.#tried(collection).add(name);
      } catch (e) {
        // best effort: ingest derives dims from the full bytes anyway
        this.#log(collection, e);
        this.#tried(collection).add(name);
      } finally {
        this.#dequeue(w, lane);
        w.dimsInflight = null;
      }
      await sleep(this.dimsInterFileDelayMs);
      return true;
    }

    w.inflight = name;
    try {
      const r = await this.ingest.ensure(collection, name, "output");
      if (r.status === 404) {
        // gone from the source: an entry state, permanent (C5)
        await this.store.entryGone(collection, name);
        w.errors = 0;
        this.#dequeue(w, lane);
      } else if (r.status === 200) {
        w.errors = 0;
        this.#dequeue(w, lane);
      } else {
        throw new Error(`status ${r.status}`);
      }
      await sleep(this.interFileDelayMs);
    } catch (e) {
      // backing stalled/down: requeue at the tail, back off this
      // collection only (the outage never stalls another host)
      w.errors += 1;
      this.#log(collection, e);
      this.#requeue(w, lane, name);
      await this.#sleepUntil(Math.min(2 ** w.errors * 1000, MAX_BACKOFF));
    } finally {
      w.inflight = null;
    }
    return true;
  }

  // A sleep that ends early when stop() flips the flag — stop() awaits the
  // workers, so a capped backoff must not hold the shutdown for 30 s.
  async #sleepUntil(ms) {
    const end = Date.now() + ms;
    while (this.running && Date.now() < end) {
      await sleep(Math.min(100, end - Date.now()));
    }
  }

  #laneQueues(w, lane) {
    switch (lane) {
      case "dimsPrio": return [w.dimsPrio, w.dimsPrioSet];
      case "dimsWalk": return [w.dimsWalk, w.dimsWalkSet];
      case "prio": return [w.prio, w.prioSet];
      default: return [w.walk, w.walkSet];
    }
  }

  #dequeue(w, lane) {
    const [q, s] = this.#laneQueues(w, lane);
    s.delete(q.shift());
  }

  #requeue(w, lane, name) {
    const [q, s] = this.#laneQueues(w, lane);
    s.delete(q.shift());
    q.push(name); s.add(name);
  }

  async stop() {
    this.running = false;
    await Promise.allSettled(
      [...this.workers.values()].map((w) => w.task).filter(Boolean),
    );
  }
}
