// Engine-owned, GET-only source telemetry. Preferences stay on collection;
// this cache is ephemeral and shared only by aliases of the same address.
import { isFolderHost } from "./backings/index.mjs";

const clean = (text) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

export function operationProgress(text, changedFrom = 0) {
  const stripped = clean(text);
  let latest = null;
  // tqdm's unitless counters describe operations. Explicit byte/rate units
  // describe transfers and must not be presented as sampling steps.
  for (const m of stripped.matchAll(/(?:^|[^\d.+-])(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)(?![\d.])/g)) {
    if (m.index + m[0].length <= changedFrom) continue;
    const counterAt = m.index + m[0].indexOf(m[1]);
    const start = Math.max(stripped.lastIndexOf("\n", counterAt), stripped.lastIndexOf("\r", counterAt)) + 1;
    const line = stripped.slice(start).split(/[\n\r]/)[0];
    if (/\b(?:bytes?|download(?:ing)?|upload(?:ing)?)\b|(?:^|[^a-z])(?:[KMGT]?i?B)(?:\/s)?\b/i.test(line)) continue;
    const value = Number(m[1]), max = Number(m[2]);
    if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) continue;
    latest = { value, max, fraction: Math.min(1, Math.max(0, value / max)) };
  }
  return latest;
}

const fingerprint = ({ t, m }) => JSON.stringify([t, m]);
const template = ({ m }) => clean(m).replace(/\d+(?:\.\d+)?/g, "#");

export class ProgressLog {
  entries = null;
  prompt = null;
  progress = null;

  sample(buffer, prompt) {
    const next = buffer.entries;
    const previous = this.entries;
    const stable = prompt && prompt === this.prompt;
    this.entries = next;
    this.prompt = prompt;
    if (!stable || !previous) { this.progress = null; return null; }
    const old = previous.map(fingerprint), now = next.map(fingerprint);
    if (old.length === now.length && old.every((f, i) => f === now[i])) return this.progress;
    let prefix = 0;
    while (prefix < Math.min(old.length, now.length) && old[prefix] === now[prefix]) prefix++;
    let from = prefix;
    if (prefix === 0) {
      let overlap = 0;
      for (let n = Math.min(old.length, now.length); n > 0; n--) {
        if (old.slice(-n).every((f, i) => f === now[i])) { overlap = n; break; }
      }
      if (overlap) from = overlap;
      else if (previous.length === next.length && previous.length &&
          previous.every((e, i) => template(e) === template(next[i]))) {
        // An overwritten tqdm entry has a content-template fingerprint;
        // timestamps alone (often duplicates) never establish continuity.
        from = 0;
      } else { this.progress = null; return null; }
    }
    // Include a preceding fragment, but require the counter to extend into
    // changed text: an old complete 100% line cannot win over a fresh fragment.
    const lead = from > 0 ? next[from - 1].m : "";
    const changed = next.slice(from).map((e) => e.m).join("");
    const parsed = operationProgress(lead + changed, clean(lead).length);
    if (parsed) this.progress = parsed;
    return this.progress;
  }

  clear() { this.entries = null; this.prompt = null; this.progress = null; }
}

const emptySnapshot = (epoch) => ({
  epoch, supported: true, state: "unknown", sampledAt: null,
  runningCount: 0, queuedCount: 0, runningPromptId: null, progress: null,
  terminalRevision: 0, resyncRevision: 0, historyGap: false, error: null,
});

export class Jobs {
  constructor({ hosts, client, onFinish = () => {}, clock = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout, epoch = () => crypto.randomUUID() }) {
    Object.assign(this, { hosts, client, onFinish, clock, setTimer, clearTimer, epoch });
    this.monitors = new Map();
    this.running = false;
    this.reconcile();
  }

  reconcile() {
    const addresses = new Map();
    for (const [id, address] of Object.entries(this.hosts)) {
      if (!address || isFolderHost(address)) continue;
      if (!addresses.has(address)) addresses.set(address, new Set());
      addresses.get(address).add(id);
    }
    for (const [address, monitor] of this.monitors) {
      if (addresses.has(address)) continue;
      this.clearTimer(monitor.timer);
      monitor.controller?.abort();
      this.monitors.delete(address);
    }
    for (const [address, sources] of addresses) {
      let monitor = this.monitors.get(address);
      if (!monitor) {
        monitor = { address, sources, snapshot: emptySnapshot(this.epoch()),
          baseline: false, seen: new Set(), boundary: null, tracked: new Set(),
          logs: new ProgressLog(), errors: 0, timer: null, task: null, controller: null };
        this.monitors.set(address, monitor);
        if (this.running) this.#schedule(monitor, 0);
      }
      monitor.sources = sources;
    }
  }

  snapshot(id) {
    const address = this.hosts[id];
    if (isFolderHost(address)) return { supported: false, reason: "No generation jobs for folder sources" };
    const snapshot = this.monitors.get(address)?.snapshot ?? emptySnapshot(null);
    return { ...snapshot, progress: snapshot.progress ? { ...snapshot.progress } : null };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.reconcile();
    for (const monitor of this.monitors.values()) this.#schedule(monitor, 0);
  }

  #schedule(monitor, delay) {
    this.clearTimer(monitor.timer);
    monitor.timer = this.setTimer(() => this.#tick(monitor), delay);
  }

  tick(address) {
    this.reconcile();
    return Promise.all([...this.monitors.values()].filter((m) => !address || address === m.address).map((m) => this.#tick(m)));
  }

  #tick(monitor) {
    if (monitor.task) return monitor.task;
    this.clearTimer(monitor.timer);
    monitor.timer = null;
    monitor.controller = new AbortController();
    monitor.task = this.#observe(monitor).finally(() => {
      monitor.task = null;
      if (this.running && this.monitors.get(monitor.address) === monitor) {
        const delay = monitor.errors ? Math.min(2000 * 2 ** (monitor.errors - 1), 30_000)
          : monitor.snapshot.runningCount || monitor.snapshot.queuedCount ? 2000 : 5000;
        this.#schedule(monitor, delay);
      }
    });
    return monitor.task;
  }

  async #observe(monitor) {
    const alive = () => this.monitors.get(monitor.address) === monitor && !monitor.controller.signal.aborted;
    const options = { signal: monitor.controller.signal };
    const client = this.client(monitor.address);
    const s = { ...monitor.snapshot };
    let notifications = 0;
    const terminal = (entry, baseline = false) => {
      if (!entry.terminal) return;
      monitor.tracked.delete(entry.id);
      if (monitor.seen.has(entry.id)) return;
      monitor.seen.add(entry.id);
      if (!baseline) { s.terminalRevision++; notifications++; }
    };
    try {
      // Retained history baseline precedes queue discovery, so startup cannot
      // replay old outputs as new finishes.
      if (!monitor.baseline) {
        const history = await client.history(options);
        if (!alive()) return;
        for (const entry of history) terminal(entry, true);
        monitor.boundary = history.filter((e) => e.terminal).at(-1)?.id ?? null;
        monitor.baseline = true;
      }
      const queue = await client.queue(options);
      if (!alive()) return;
      for (const id of [...queue.running, ...queue.pending]) {
        if (!monitor.seen.has(id)) monitor.tracked.add(id);
      }
      let limit = 64, history;
      while (true) {
        history = await client.history({ ...options, maxItems: limit });
        if (!alive()) return;
        if ((monitor.boundary && history.some((e) => e.id === monitor.boundary)) || history.length < limit) break;
        limit *= 2;
      }
      const gap = !!monitor.boundary && !history.some((e) => e.id === monitor.boundary);
      if (gap && !s.historyGap) { s.resyncRevision++; notifications++; }
      s.historyGap = gap;
      for (const entry of history) terminal(entry);
      const boundary = history.filter((e) => e.terminal).at(-1)?.id;
      // A clear has no boundary; the next populated history is still reconciled
      // against seen IDs, never treated as a second startup baseline.
      monitor.boundary = boundary ?? null;
      for (const id of monitor.tracked) {
        if (queue.running.includes(id) || queue.pending.includes(id)) continue;
        const targeted = await client.history({ ...options, promptId: id });
        if (!alive()) return;
        for (const entry of targeted) terminal(entry);
      }
      let running = queue.running.filter((id) => !monitor.seen.has(id));
      let pending = queue.pending.filter((id) => !monitor.seen.has(id));
      let progress = null;
      if (running.length === 1) {
        let logs = null;
        try { logs = await client.logs(options); } catch { /* counters are best effort */ }
        if (!alive()) return;
        // A stable prompt brackets the log read. A terminal history record wins
        // over either older queue snapshot.
        const after = await client.queue(options);
        if (!alive()) return;
        const bracketed = after.running.length === 1 && after.running[0] === running[0];
        running = after.running.filter((id) => !monitor.seen.has(id));
        pending = after.pending.filter((id) => !monitor.seen.has(id));
        if (logs && bracketed) progress = monitor.logs.sample(logs, running[0]);
        else monitor.logs.clear();
      } else monitor.logs.clear();
      if (monitor.errors) { s.resyncRevision++; notifications++; }
      monitor.errors = 0;
      Object.assign(s, { state: running.length ? "running" : "idle", sampledAt: this.clock(),
        runningCount: running.length, queuedCount: pending.length,
        runningPromptId: running.length === 1 ? running[0] : null,
        progress: running.length === 1 ? progress : null, error: null });
      monitor.snapshot = s;
      if (notifications) this.onFinish(monitor.address, monitor.sources, { ...s });
    } catch (error) {
      if (!alive()) return;
      monitor.errors++;
      monitor.logs.clear();
      monitor.snapshot = { ...s, state: "disconnected", sampledAt: this.clock(),
        runningPromptId: null, progress: null, error: error?.message ?? String(error) };
      if (notifications) this.onFinish(monitor.address, monitor.sources, { ...monitor.snapshot });
    }
  }

  async stop() {
    this.running = false;
    for (const monitor of this.monitors.values()) {
      this.clearTimer(monitor.timer);
      monitor.controller?.abort();
    }
    await Promise.allSettled([...this.monitors.values()].map((m) => m.task).filter(Boolean));
  }
}
