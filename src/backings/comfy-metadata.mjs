import { InventoryError, cancelled } from "./inventory.mjs";

const HTTP_DATE = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
export function parseHttpDate(value) {
  if (typeof value !== "string" || !HTTP_DATE.test(value)) return null;
  const atMs = Date.parse(value);
  return Number.isFinite(atMs) && new Date(atMs).toUTCString() === value ? atMs : null;
}

export function interpretHeaders(response) {
  const h = response.headers;
  if (!h || typeof h.get !== "function") throw new InventoryError("malformed-response", "Missing HTTP headers");
  const rawSize = h.get("Content-Length"), lm = h.get("Last-Modified"), etag = h.get("ETag");
  const size = rawSize === null ? null : /^(0|[1-9]\d*)$/.test(rawSize) && Number.isSafeInteger(Number(rawSize)) ? Number(rawSize) : NaN;
  const atMs = parseHttpDate(lm);
  return { stamp: etag ?? (lm || rawSize ? `${lm}|${rawSize}` : null), size,
    modified: atMs === null ? null : { atMs, precisionMs: 1000, source: "http-last-modified" } };
}

// Slots track physical transport settlement. A cancelled logical read releases
// its waiter immediately, but cannot free a physical slot for an ignored abort.
export function makeMetadataCollector({ urlFor, fetcher = fetch, signal: ownerSignal,
  clock = () => performance.now(), concurrency = 4, requestTimeoutMs = 10_000 } = {}) {
  const queued = [], jobs = new Set(); let active = 0, stopped = false, peak = 0;
  const fail = (code, name, message, extra = {}) => new InventoryError(code, `${name}: ${message}`, { path: name, ...extra });
  const pump = () => {
    while (!stopped && !ownerSignal?.aborted && active < concurrency && queued.length) {
      const job = queued.shift();
      if (job.done || job.signal?.aborted) { job.finish(job.signal?.reason ?? cancelled()); continue; }
      active++; peak = Math.max(peak, active); job.started = true;
      Promise.resolve().then(() => {
        if (stopped || job.signal?.aborted || ownerSignal?.aborted) throw cancelled();
        return fetcher(urlFor(job.name, job.kind), { method: "HEAD", headers: { "Accept-Encoding": "identity", "Cache-Control": "no-cache" },
          cache: "no-store", signal: job.controller.signal });
      }).then((response) => {
        response?.body?.cancel().catch(() => {});
        if (job.done) return;
        if (!response || !Number.isInteger(response.status)) throw fail("malformed-response", job.name, "Invalid HEAD response");
        if (response.status === 404) { job.finish(null, { kind: "not-found", name: job.name, status: 404, reason: "source-not-found" }); return; }
        if (response.status !== 200) throw fail("http-status", job.name, `HEAD returned ${response.status}`, { status: response.status });
        const metadata = interpretHeaders(response);
        if (!metadata.modified) throw fail("invalid-date", job.name, "HEAD has missing or invalid Last-Modified");
        if (Number.isNaN(metadata.size)) throw fail("invalid-length", job.name, "HEAD has invalid Content-Length");
        job.finish(null, { kind: "present", name: job.name, status: 200, ...metadata });
      }).catch((error) => job.finish(error)).finally(() => { active--; pump(); });
    }
  };
  const stop = () => {
    stopped = true;
    for (const job of [...jobs]) job.finish(ownerSignal?.reason ?? cancelled());
    queued.length = 0;
  };
  ownerSignal?.addEventListener("abort", stop, { once: true });
  return {
    observe(name, { signal, kind = "output", deadlineMs = Infinity } = {}) {
      if (stopped || ownerSignal?.aborted || signal?.aborted) return Promise.reject(signal?.reason ?? ownerSignal?.reason ?? cancelled());
      return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const job = { name, kind, signal, controller, done: false, started: false };
        const abort = () => job.finish(signal?.reason ?? ownerSignal?.reason ?? cancelled());
        const budget = Math.min(requestTimeoutMs, deadlineMs - clock());
        const timer = setTimeout(() => job.finish(fail("timeout", name, "HEAD deadline exceeded")), Math.max(0, budget));
        job.finish = (error, value) => {
          if (job.done) return;
          job.done = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); ownerSignal?.removeEventListener("abort", abort);
          jobs.delete(job);
          const at = queued.indexOf(job); if (at >= 0) queued.splice(at, 1);
          if (error) { controller.abort(error); reject(error); } else resolve(value);
        };
        signal?.addEventListener("abort", abort, { once: true }); ownerSignal?.addEventListener("abort", abort, { once: true });
        jobs.add(job); queued.push(job); pump();
      });
    },
    stats() { return { active, queued: queued.length, logicalActive: [...jobs].filter((job) => job.started).length, peak }; },
    dispose() { ownerSignal?.removeEventListener("abort", stop); stop(); },
  };
}
