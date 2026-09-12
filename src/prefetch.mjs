// src/prefetch.mjs — the ingestion path running ahead of the user.
//
// Walks each collection's listing and calls ingest.ensure (bytes → hash →
// cache → content → entry). The politeness set (spec harvest #8):
//   single-flight per collection, a small inter-file gap, per-collection
//   backoff capped at 30 s (one host's outage never stalls another),
//   404 ⇒ entry.state='gone' (permanent), two-tier queue where on-screen
//   priority actually promotes, pause gate.
// Must run headless — ingestion never requires an open browser.

import { EXTRACTOR_VERSION } from "./extractor.mjs";

const INTER_FILE_DELAY = 100;   // ms between file fetches
const MAX_BACKOFF = 30_000;     // backoff cap

export class Prefetch {
  // hosts: { name: "host:port" }; enabled/paused come from settings.
  constructor({ hosts, store, settings, ingest, interFileDelayMs = INTER_FILE_DELAY }) {
    this.hosts = hosts;
    this.store = store;
    this.settings = settings;
    this.ingest = ingest;
    this.interFileDelayMs = interFileDelayMs;
    // collection -> { prio: [], prioSet: Set, walk: [], walkSet: Set, inflight, errors }
    this.workers = new Map();
    this.running = false;
  }

  #w(collection) {
    if (!this.workers.has(collection)) {
      this.workers.set(collection, { prio: [], prioSet: new Set(), walk: [], walkSet: new Set(), inflight: null, errors: 0 });
    }
    return this.workers.get(collection);
  }

  pending(collection) {
    const w = this.workers.get(collection);
    if (!w) return 0;
    return w.prio.length + w.walk.length + (w.inflight ? 1 : 0);
  }

  // Queue names that are unknown or stale (older extractor version).
  // priority=true promotes to the prio lane: already prio'd is skipped;
  // sitting in the walk lane MOVES to prio (want actually promotes — E12).
  feed(collection, names, priority = false) {
    if (!names?.length) return this.pending(collection);
    const fresh = this.store.metaFresh(collection, EXTRACTOR_VERSION);
    const w = this.#w(collection);
    for (const name of names) {
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
          const w = self.workers.get(collection);
          if (!w || w.inflight) continue;

          // peek — never demote a prio item when paused (E13)
          let name = null, lane = null;
          if (w.prio.length) { name = w.prio[0]; lane = "prio"; }
          else if (enabled && w.walk.length) { name = w.walk[0]; lane = "walk"; }
          if (name === null || paused) continue;

          didWork = true;
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

  #dequeue(w, lane) {
    const q = lane === "prio" ? w.prio : w.walk;
    const s = lane === "prio" ? w.prioSet : w.walkSet;
    s.delete(q.shift());
  }

  #requeue(w, lane, name) {
    const q = lane === "prio" ? w.prio : w.walk;
    const s = lane === "prio" ? w.prioSet : w.walkSet;
    s.delete(q.shift());
    q.push(name); s.add(name);
  }

  stop() {
    this.running = false;
  }
}
