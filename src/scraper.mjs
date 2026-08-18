// src/scraper.mjs — background metadata extraction walker.
//
// Async port of the outgoing _meta_worker_main (server.py:834–890), keeping
// the harvested politeness set verbatim (spec harvest #8):
//   single-flight, 100 ms inter-file gaps, backoff capped at 30 s,
//   HTTP 404 ⇒ permanent, two-tier queue (on-screen priority beats the
//   background walk), pause gate.
// Must run headless — extraction never requires an open browser.

import { metaFromPngBytes } from "./extractor.mjs";

const INTER_FILE_DELAY = 100;   // ms between file fetches
const MAX_BACKOFF = 30_000;     // backoff cap
const EXTRACTOR_VERSION = 1;

export class Scraper {
  // hosts: { name: "host:port" }; store: Store; enabled/paused come from settings
  constructor({ hosts, store, settings }) {
    this.hosts = hosts;
    this.store = store;
    this.settings = settings;
    // host -> { prio: [], prioSet: Set, walk: [], walkSet: Set, inflight }
    this.workers = new Map();
    this.running = false;
  }

  #w(host) {
    if (!this.workers.has(host)) {
      this.workers.set(host, { prio: [], prioSet: new Set(), walk: [], walkSet: new Set(), inflight: null });
    }
    return this.workers.get(host);
  }

  pending(host) {
    const w = this.workers.get(host);
    if (!w) return 0;
    return w.prio.length + w.walk.length + (w.inflight ? 1 : 0);
  }

  // Queue names that are unknown or stale. priority=true promotes to the
  // prio queue (drains even when the background walk is disabled).
  feed(host, names, priority = false) {
    if (!names?.length) return this.pending(host);
    const w = this.#w(host);
    for (const name of names) {
      if (w.prioSet.has(name) || w.walkSet.has(name)) continue;
      if (priority) {
        if (w.walkSet.has(name)) {
          w.walkSet.delete(name);
          w.walk = w.walk.filter((n) => n !== name);
        }
        w.prio.push(name); w.prioSet.add(name);
      } else {
        w.walk.push(name); w.walkSet.add(name);
      }
    }
    return this.pending(host);
  }

  async #fetchMeta(host, name) {
    const addr = this.hosts[host];
    const url = `http://${addr}/api/view?type=output&filename=${encodeURIComponent(name)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (r.status === 404) return { permanent: true }; // gone from the host — never retry
    if (!r.ok) throw new Error(`status ${r.status}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    const [meta, hasWorkflow] = await metaFromPngBytes(buf);
    return { meta, hasWorkflow };
  }

  async start() {
    if (this.running) return;
    this.running = true;
    const self = this;
    (async function loop() {
      const errors = new Map(); // host -> consecutive error count
      while (self.running) {
        const enabled = self.settings.get("core.scraper", "enabled", true);
        const paused = self.settings.get("core.scraper", "paused", false);
        let didWork = false;

        for (const host of Object.keys(self.hosts)) {
          const w = self.workers.get(host);
          if (!w) continue;

          let name = null;
          if (w.prio.length) {
            name = w.prio.shift(); w.prioSet.delete(name);
          } else if (enabled && w.walk.length) {
            name = w.walk.shift(); w.walkSet.delete(name);
          }
          if (name === null) continue;
          if (paused) { // pause gate: put it back, wait
            w.walk.unshift(name); w.walkSet.add(name);
            continue;
          }

          didWork = true;
          w.inflight = name;
          try {
            const { meta, hasWorkflow, permanent } = await self.#fetchMeta(host, name);
            errors.set(host, 0);
            if (permanent) {
              await self.store.metaPut(host, name, null, { source: "png", nopng: true, ext: EXTRACTOR_VERSION });
            } else if (meta) {
              await self.store.metaPut(host, name, meta, { source: "png", hasWorkflow, ext: EXTRACTOR_VERSION });
            } else {
              await self.store.metaPut(host, name, null, { source: "png", nopng: true, ext: EXTRACTOR_VERSION });
            }
            await new Promise((r) => setTimeout(r, INTER_FILE_DELAY));
          } catch {
            // host stalled/down: requeue for later, back off progressively
            const n = (errors.get(host) ?? 0) + 1;
            errors.set(host, n);
            w.inflight = null;
            if (!w.walkSet.has(name)) { w.walk.push(name); w.walkSet.add(name); }
            await new Promise((r) => setTimeout(r, Math.min(2 ** n * 1000, MAX_BACKOFF)));
          }
          w.inflight = null;
        }

        if (!didWork) await new Promise((r) => setTimeout(r, 1000)); // idle re-check
      }
    })();
  }

  stop() {
    this.running = false;
  }
}
