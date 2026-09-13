// src/prefetch.mjs — the ingestion path running ahead of the user.
//
// TWO PASSES over each collection's listing (§4.2): pass 1 reads 64 KB dims
// heads (cheap, ~100 entries/s) so every entry carries width/height before
// ingest; pass 2 calls ingest.ensure (bytes → hash → cache → content →
// entry) at the existing politeness. The dims queue drains before ingestion
// starts. The politeness set (spec harvest #8):
//   single-flight per collection, a small inter-file gap, per-collection
//   backoff capped at 30 s (one host's outage never stalls another),
//   404 ⇒ entry.state='gone' (permanent), two-tier queues where on-screen
//   priority actually promotes (in BOTH passes), pause gate.
// Must run headless — ingestion never requires an open browser.

import { EXTRACTOR_VERSION } from "./extractor.mjs";
import { backingFor } from "./backings/index.mjs";

const INTER_FILE_DELAY = 100;      // ms between ingest reads (pass 2)
const DIMS_INTER_FILE_DELAY = 10;  // ms between head reads (pass 1 — 64 KB is cheap)
const MAX_BACKOFF = 30_000;     // backoff cap
const LIST_REFRESH_MS = 60_000; // re-list each collection at most this often

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
    //                 prio, prioSet, walk, walkSet, inflight, errors }
    this.workers = new Map();
    this.#lastList = new Map(); // collection -> ts
    this.running = false;
  }

  #lastList;
  // collection -> Set of names whose head read yielded no dims. In-memory
  // only: a listing refresh must not re-read them every round, and the full
  // ingest derives dims from the complete bytes anyway (the pass-2 fallback).
  #dimsTried = new Map();

  #w(collection) {
    if (!this.workers.has(collection)) {
      this.workers.set(collection, {
        dimsPrio: [], dimsPrioSet: new Set(), dimsWalk: [], dimsWalkSet: new Set(), dimsInflight: null,
        prio: [], prioSet: new Set(), walk: [], walkSet: new Set(), inflight: null, errors: 0,
      });
    }
    return this.workers.get(collection);
  }

  #tried(collection) {
    let s = this.#dimsTried.get(collection);
    if (!s) { s = new Set(); this.#dimsTried.set(collection, s); }
    return s;
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
    const self = this;
    (async function loop() {
      while (self.running) {
        const enabled = self.settings.get("core.scraper", "enabled", true);
        const paused = self.settings.get("core.scraper", "paused", false);
        let didWork = false;

        for (const collection of Object.keys(self.hosts)) {
          // the walk lane is fed by this loop listing each collection (the
          // listing route has no side effects — E3) at most once per refresh
          const last = self.#lastList.get(collection) ?? 0;
          if (Date.now() - last > self.listRefreshMs) {
            self.#lastList.set(collection, Date.now());
            try {
              const listing = await backingFor(self.hosts[collection]).list(self.hosts[collection]);
              self.feed(collection, listing.map((f) => f.name ?? f));
            } catch { /* listing failed this round — the walk retries next tick */ }
          }

          const w = self.workers.get(collection);
          if (!w || w.inflight || w.dimsInflight) continue;

          // pass 1 (dims) drains before pass 2 (ingest) starts; want
          // promotes within each pass. peek — never demote a prio item when
          // paused (E13)
          let name = null, lane = null;
          if (w.dimsPrio.length) { name = w.dimsPrio[0]; lane = "dimsPrio"; }
          else if (enabled && w.dimsWalk.length) { name = w.dimsWalk[0]; lane = "dimsWalk"; }
          else if (w.prio.length) { name = w.prio[0]; lane = "prio"; }
          else if (enabled && w.walk.length) { name = w.walk[0]; lane = "walk"; }
          if (name === null || paused) continue;

          didWork = true;
          if (lane === "dimsPrio" || lane === "dimsWalk") {
            w.dimsInflight = name;
            try {
              const r = await self.ingest.dims(collection, name);
              if (r.status === 404) {
                // gone from the source — the same signal pass 2 acts on
                // (C5), observed one pass earlier
                await self.store.entryGone(collection, name);
              }
              if (!r.dims) self.#tried(collection).add(name);
            } catch {
              // best effort: ingest derives dims from the full bytes anyway
              self.#tried(collection).add(name);
            } finally {
              self.#dequeue(w, lane);
              w.dimsInflight = null;
            }
            await new Promise((r) => setTimeout(r, self.dimsInterFileDelayMs));
            continue;
          }
          w.inflight = name;
          try {
            const r = await self.ingest.ensure(collection, name, "output");
            if (r.status === 404) {
              // gone from the source: an entry state, permanent (C5)
              await self.store.entryGone(collection, name);
              w.errors = 0;
              self.#dequeue(w, lane);
            } else if (r.status === 200) {
              w.errors = 0;
              self.#dequeue(w, lane);
            } else {
              throw new Error(`status ${r.status}`);
            }
            await new Promise((r) => setTimeout(r, self.interFileDelayMs));
          } catch {
            // backing stalled/down: requeue at the tail, back off this
            // collection only (E14 — the outage never stalls another host)
            w.errors += 1;
            self.#requeue(w, lane, name);
            await new Promise((r) => setTimeout(r, Math.min(2 ** w.errors * 1000, MAX_BACKOFF)));
          } finally {
            w.inflight = null;
          }
        }

        if (!didWork) await new Promise((r) => setTimeout(r, 1000)); // idle re-check
      }
    })();
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

  stop() {
    this.running = false;
  }
}
