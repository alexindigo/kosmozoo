// One committed registry and cached source projection, independent of browser count.
import { isFolderHost } from "./backings/index.mjs";
import { sourceAttributes } from "./collections.mjs";

export const SOURCE_STREAM_CHUNK_BYTES = 16 * 1024;
// Demand-only delivery keeps the JS byte queue empty, stricter than the64KiB cap.
export const SOURCE_STREAM_HIGH_WATER_BYTES = 0;
const encoder = new TextEncoder();

export class SourceActivity {
  #rows = new Map();
  #subscribers = new Set();
  #unsubscribeStore;
  #unsubscribeJobs;
  #stopped = false;
  #finalSnapshot = null;
  constructor({ store, hosts, inventory, jobs, epoch = crypto.randomUUID(),
    setHeartbeat = setInterval, clearHeartbeat = clearInterval, report = error => console.error("Source stream delivery failed:", error) }) {
    Object.assign(this, { store, hosts, inventory, jobs, epoch, setHeartbeat, clearHeartbeat, report });
    this.revision = 0;
    // Explicitly injected host maps are valid fixtures, even with an empty Store.
    for (const [id, address] of Object.entries(hosts)) this.#rows.set(id,
      { pinned: 0, auto_refresh: 0, ...store.collectionGet(id), id, address, kind: isFolderHost(address) ? "folder" : "comfy" });
    this.#unsubscribeStore = store.subscribeCollections(event => this.#committed(event));
    this.#unsubscribeJobs = jobs.subscribe(() => this.#publish());
  }

  #committed({ id, row }) {
    if (this.#stopped) return;
    // Address-less placeholder insertion is not source membership. In particular,
    // ingestion under an explicit fake host must not retire that injected host.
    if (row && !row.address) return;
    if (row?.address) {
      this.#rows.set(id, row);
      Object.defineProperty(this.hosts, id, { value: row.address, enumerable: true, writable: true, configurable: true });
    } else {
      this.#rows.delete(id);
      delete this.hosts[id];
    }
    // This synchronous boundary cannot coalesce away a remove/re-add lifetime.
    this.inventory.reconcile();
    this.jobs.reconcile();
    this.#publish();
  }

  source(id) {
    if (this.#stopped) return Object.hasOwn(this.#finalSnapshot.sources, id) ? this.#finalSnapshot.sources[id] : null;
    const row = this.#rows.get(id);
    if (!row) return null;
    const incarnation = this.inventory.capture(id).incarnation;
    return { address: row.address, kind: row.kind, incarnation, ...sourceAttributes(row),
      sourceVersion: { epoch: this.epoch, incarnation, attributesRevision: this.store.collectionRevision(id) },
      activity: this.jobs.snapshot(id) };
  }

  snapshot() {
    if (this.#stopped) return this.#finalSnapshot;
    return { version: 1, epoch: this.epoch, revision: this.revision,
      sources: Object.fromEntries([...this.#rows.keys()].map(id => [id, this.source(id)])) };
  }

  cursor() { return { epoch: this.epoch, revision: this.revision }; }
  acceptingChanges() { return !this.#stopped; }

  #publish() {
    if (this.#stopped) return;
    this.revision++;
    const snapshot = this.snapshot();
    for (const subscriber of this.#subscribers) subscriber.offer(snapshot);
  }

  open(request) {
    if (this.#stopped) return new Response("Source streams stopped", { status: 503 });
    let controller, active = null, offset = 0, pending = null, heartbeat = false, wake = null, retired = false, timer;
    const resume = () => { const resolve = wake; wake = null; resolve?.(); };
    const retire = close => {
      if (retired) return;
      retired = true;
      this.#subscribers.delete(subscriber);
      this.clearHeartbeat(timer);
      request.signal.removeEventListener("abort", abort);
      active = null; pending = null; heartbeat = false; resume();
      if (close) { try { controller.close(); } catch (error) { this.report(error); } }
    };
    const abort = () => retire(true);
    const subscriber = {
      offer(snapshot) { if (!retired) { pending = snapshot; resume(); } },
      retire,
      stats: () => ({ activeFrames: active ? 1 : 0, pendingFrames: pending ? 1 : 0,
        queuedBytes: Math.max(0, -(controller?.desiredSize ?? 0)) }),
    };
    const body = new ReadableStream({
      start: c => {
        controller = c;
        // Registration and capture are synchronous; there is no probing await.
        this.#subscribers.add(subscriber);
        subscriber.offer(this.snapshot());
        request.signal.addEventListener("abort", abort, { once: true });
        timer = this.setHeartbeat(() => { if (!retired) { heartbeat = true; resume(); } }, 15000);
        if (request.signal.aborted) retire(true);
      },
      pull: async c => {
        try {
          if (!active && !pending && !heartbeat) await new Promise(resolve => { wake = resolve; });
          if (retired) return;
          if (!active) {
            if (pending) {
              const snapshot = pending; pending = null;
              active = encoder.encode(`event: sources\nid: ${snapshot.epoch}:${snapshot.revision}\ndata: ${JSON.stringify(snapshot)}\n\n`);
            } else { heartbeat = false; active = encoder.encode(": heartbeat\n\n"); }
            offset = 0;
          }
          const end = Math.min(offset + SOURCE_STREAM_CHUNK_BYTES, active.byteLength);
          c.enqueue(active.slice(offset, end)); offset = end;
          if (offset === active.byteLength) { active = null; offset = 0; }
        } catch (error) { this.report(error); retire(true); }
      },
      cancel() { retire(false); },
    }, { highWaterMark: SOURCE_STREAM_HIGH_WATER_BYTES, size: chunk => chunk.byteLength });
    return new Response(body, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" } });
  }

  deliveryStats() { return [...this.#subscribers].map(subscriber => subscriber.stats()); }

  stop() {
    if (this.#stopped) return;
    this.#finalSnapshot = this.snapshot();
    this.#stopped = true;
    this.#unsubscribeStore(); this.#unsubscribeJobs();
    for (const subscriber of [...this.#subscribers]) subscriber.retire(true);
  }
}
