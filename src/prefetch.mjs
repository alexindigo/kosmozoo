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
import { makeCollectionInventory, makeCollectionLifecycle } from "./backings/index.mjs";

const INTER_FILE_DELAY = 100;      // ms between ingest reads (pass 2)
const DIMS_INTER_FILE_DELAY = 10;  // ms between head reads (pass 1 — 64 KB is cheap)
const MAX_BACKOFF = 30_000;     // backoff cap
const LIST_REFRESH_MS = 60_000; // re-list each collection at most this often
const IDLE_MS = 1000;           // re-check cadence when a worker has nothing to do

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Prefetch {
  // hosts: { name: "host:port" }; enabled/paused come from settings.
  constructor({ hosts, store, settings, ingest, inventory, interFileDelayMs = INTER_FILE_DELAY, dimsInterFileDelayMs = DIMS_INTER_FILE_DELAY, listRefreshMs = LIST_REFRESH_MS, clock = () => performance.now() }) {
    this.hosts = hosts;
    this.store = store;
    this.settings = settings;
    this.ingest = ingest;
    this.ownsInventory = !inventory;
    this.inventory = inventory ?? makeCollectionInventory(hosts);
    const lifecycle = makeCollectionLifecycle(hosts);
    this.capture = this.inventory.capture ?? lifecycle.capture;
    this.isCurrent = this.inventory.isCurrent ?? lifecycle.isCurrent;
    this.clock = clock;
    this.interFileDelayMs = interFileDelayMs;
    this.dimsInterFileDelayMs = dimsInterFileDelayMs;
    this.listRefreshMs = listRefreshMs;
    // collection -> { dimsPrio, dimsPrioSet, dimsWalk, dimsWalkSet, dimsInflight,
    // prio, prioSet, walk, walkSet, inflight, errors, task, lastError }
    this.workers = new Map();
    this.running = false;
  }

  // collection -> Set of names whose head read yielded no dims. In-memory
  // only: a listing refresh must not re-read them every round, and the full
  // ingest derives dims from the complete bytes anyway (the pass-2 fallback).

  #w(collection) {
    const token = this.capture(collection);
    if (!this.workers.has(collection) || this.workers.get(collection).token !== token) {
      this.workers.set(collection, {
        token, requested: 1, acknowledged: 0, lastList: null, tried: new Set(),
        nextListAttempt: 0, listFailures: 0,
        unavailable: [], checkedUnavailable: new Set(), snapshot: null,
        dimsPrio: [], dimsPrioSet: new Set(), dimsWalk: [], dimsWalkSet: new Set(), dimsInflight: null,
        prio: [], prioSet: new Set(), walk: [], walkSet: new Set(), inflight: null,
        errors: 0, task: null, lastError: null,
      });
    }
    return this.workers.get(collection);
  }

  #tried(collection) {
    return this.#w(collection).tried;
  }

  #current(collection, w) { return this.workers.get(collection) === w && this.isCurrent(w.token); }

  #log(collection, e, w = this.workers.get(collection)) {
    if (!w || !this.#current(collection, w)) return;
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

  // Invalidating BEFORE a list await preserves a completion that arrives
  // during that read: it leaves another list due on the following step.
  requestRelist(collection) {
    if (!(collection in this.hosts)) return;
    const w = this.#w(collection);
    w.requested++;
    w.nextListAttempt = 0;
    if (this.running && !w.task) w.task = this.#runCollection(collection, w);
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
    if (this.running && !w.task) w.task = this.#runCollection(collection, w);
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
      w.task = this.#runCollection(id, w);
    }
  }

  // One worker per collection: its listing refresh, inter-file gaps and
  // backoff sleeps never touch another collection's lane. A collection
  // removed from the hosts map ends its worker — and the worker's whole
  // state dies with it, so a re-added collection starts clean (its feed
  // spawns a fresh worker: a settled task must not look like a live one).
  async #runCollection(collection, w) {
    try {
      while (this.running && collection in this.hosts && this.#current(collection, w)) {
        try {
          if (!(await this.#step(collection, w))) await sleep(IDLE_MS);
        } catch (e) {
          // a worker must never die: log + report, restart after the cap
          this.#log(collection, e, w);
          await this.#sleepUntil(MAX_BACKOFF);
        }
      }
    } finally {
      if (this.workers.get(collection) === w) {
        w.task = null;
        // A stopped worker retains its diagnostic snapshot; remove/re-add
        // while running still discards the obsolete incarnation's queues.
        if (!(collection in this.hosts) || this.running && !this.isCurrent(w.token)) this.workers.delete(collection);
      }
    }
  }

  // Process one item (or refresh the listing). Returns false when there was
  // nothing to do.
  async #step(collection, w) {
    // the walk lane is fed by listing each collection (the listing route has
    // no side effects — E3) at most once per refresh
    if (this.clock() >= w.nextListAttempt && (w.lastList === null || w.requested > w.acknowledged || this.clock() - w.lastList > this.listRefreshMs)) {
      const capturedRequest = w.requested;
      try {
      const snapshot = await this.inventory(collection, { maxAgeMs: w.lastList !== null && w.requested > w.acknowledged ? 0 : this.listRefreshMs });
      if (!this.#current(collection, w)) return false;
      this.feed(collection, snapshot.items.map((f) => f.name ?? f));
      w.lastList = this.clock(); w.acknowledged = capturedRequest;
      w.listFailures = 0; w.nextListAttempt = 0;
      if (w.snapshot !== snapshot) {
        w.snapshot = snapshot; w.checkedUnavailable.clear();
        w.unavailable = [...new Map((snapshot.unavailable ?? []).map((item) => [item.name, { ...item, snapshot }])).values()];
      }
      } catch (error) {
        if (!this.#current(collection, w)) return false;
        this.#log(collection, error, w);
        w.nextListAttempt = this.clock() + Math.min(1000 * 2 ** w.listFailures++, MAX_BACKOFF);
      }
    }

    if (!w || w.inflight || w.dimsInflight) return false;
    if (!this.#current(collection, w)) return false;
    if (w.requested > w.acknowledged && this.clock() >= w.nextListAttempt) return true;

    if (w.unavailable.length && !this.settings.get("core.prefetch", "paused", false)) {
      const task = w.unavailable[0];
      const observed = this.inventory.peek?.(collection);
      if (w.snapshot !== task.snapshot || observed && observed !== task.snapshot || w.checkedUnavailable.has(task.name)) {
        w.unavailable.shift();
      } else {
      if (!this.inventory.observeMetadata) throw new Error("Unavailable-file checks require source metadata binding");
      const result = await this.inventory.observeMetadata(collection, task.name, { token: w.token });
      if (!this.#current(collection, w)) return false;
      const newer = this.inventory.peek?.(collection);
      if (w.snapshot !== task.snapshot || newer && newer !== task.snapshot || result.kind === "cancelled") {
        w.unavailable.shift(); return true;
      }
      if (result.kind === "not-found") {
        await this.store.entryGone(collection, task.name);
        // Confirmed absence must also reclaim a pre-existing wanted job; it
        // cannot re-enter through cache/dimension shortcuts in the same observation.
        for (const [q, set] of [[w.dimsPrio, w.dimsPrioSet], [w.dimsWalk, w.dimsWalkSet], [w.prio, w.prioSet], [w.walk, w.walkSet]]) {
          const index = q.indexOf(task.name); if (index >= 0) q.splice(index, 1); set.delete(task.name);
        }
      }
      else if (result.kind !== "present") throw new Error(`Source availability check failed: ${task.name}`);
      if (!this.#current(collection, w)) return false;
      w.checkedUnavailable.add(task.name); w.unavailable.shift();
      await sleep(this.dimsInterFileDelayMs);
      }
    }

    // pass 1 (dims) drains before pass 2 (ingest) starts; want promotes
    // within each pass. peek — never demote a prio item when paused (E13)
    // Settings can change during either metadata await above. Dispatch uses
    // the current pause/enable state rather than the wave's initial state.
    const enabled = this.settings.get("core.prefetch", "enabled", true);
    const paused = this.settings.get("core.prefetch", "paused", false);
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
        if (!this.#current(collection, w) || r.cancelled) return false;
        if (r.status === 404) {
          // gone from the source — the same signal pass 2 acts on (C5),
          // observed one pass earlier
          await this.store.entryGone(collection, name);
        }
        if (!r.dims) w.tried.add(name);
      } catch (e) {
        // best effort: ingest derives dims from the full bytes anyway
        this.#log(collection, e, w);
        if (this.#current(collection, w)) w.tried.add(name);
      } finally {
        if (this.#current(collection, w)) this.#dequeue(w, lane);
        w.dimsInflight = null;
      }
      await sleep(this.dimsInterFileDelayMs);
      return true;
    }

    w.inflight = name;
    try {
      const r = await this.ingest.ensure(collection, name, "output");
      if (!this.#current(collection, w) || r.cancelled) return false;
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
      this.#log(collection, e, w);
      if (!this.#current(collection, w)) return false;
      this.#requeue(w, lane, name);
      await this.#sleepUntil(Math.min(2 ** w.errors * 1000, MAX_BACKOFF));
    } finally {
      w.inflight = null;
    }
    return true;
  }

  // A sleep that ends early when stop flips the flag — stop awaits the
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
    if (this.ownsInventory) await this.inventory.stop();
    await Promise.allSettled(
      [...this.workers.values()].map((w) => w.task).filter(Boolean),
    );
  }
}
