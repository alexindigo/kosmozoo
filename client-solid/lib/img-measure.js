// Retained native media resources shared by feed dimensions, feed src and
// inline adapters. Admission belongs to the injected Store policy, never to a
// view. Per-kind strategies: images probe with `Image`, videos with a retained
// `<video preload="metadata">`; audio (and video whose dimensions are already
// authoritative) needs no probe, so its src starts without a native resource.
import { createSignal, createEffect, createMemo, onMount, onCleanup } from "solid-js";
import { FAILURE_SIZE } from "../store/media-geometry.js";

export const ERROR_RETRY_MS = 8000;
export const MEASURE_TIMEOUT_MS = 30000;
export const validDims = (w, h) => Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0;

// The retry scheduler lives HERE and only here: one timer; when the window
// opens each callback re-queues whatever its owner retains (measurement
// waiting records, the image window's errored srcs).
let retryTimer = null;
const retryCallbacks = new Set();
export function scheduleRetry(cb) {
  if (cb) retryCallbacks.add(cb);
  if (!retryTimer) retryTimer = setTimeout(() => {
    retryTimer = null;
    const callbacks = [...retryCallbacks];
    retryCallbacks.clear();
    for (const callback of callbacks) callback();
  }, ERROR_RETRY_MS);
  return () => {
    retryCallbacks.delete(cb);
    if (!retryCallbacks.size && retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  };
}

export function imageRequestUrl(src, priority, nonce) {
  if (!src) return null;
  if (priority !== "background" && !nonce && !/[?&]priority=/.test(src)) return src;
  const [path, query = ""] = src.split("?");
  const params = new URLSearchParams(query);
  params.delete("priority");
  if (priority === "background") params.set("priority", "background");
  if (nonce) params.set("_r", nonce);
  return path + (params.size ? "?" + params : "");
}

// Retire a native probe before its capacity is released: no handler, no
// source, and a video's native consumer is reset.
function detach(el) {
  if (!el) return;
  el.onload = el.onerror = el.onloadedmetadata = null;
  const player = el.tagName === "VIDEO";
  if (player) el.pause();
  el.removeAttribute("src");
  if (player) el.load();
}

// kindOf(id) → "image" | "video" | "audio"; knownSize(id) → authoritative
// listing/extractor dimensions, which win over a late measurement error.
export function makeImageMeasurements({ acquisition, srcFor, identityFor = id => id,
  kindOf = () => "image", knownSize = () => null }) {
  const records = new Map();
  const displays = new Set();
  let context = null, disposed = false, cancelRetry = null;
  const [version, setVersion] = createSignal(0);
  const bump = () => setVersion(value => value + 1);
  // identity null retires an entry; "" means its hash is not known yet.
  // Learning the first hash enriches the same content (matching inventory
  // reconciliation); only a change between known hashes retires a record.
  const matches = (record, identity = identityFor(record.id)) => {
    if (record.identity === "" && typeof identity === "string" && identity !== "") record.identity = identity;
    return record.identity === identity;
  };
  const current = record => !disposed && record.context === context && records.get(record.id) === record && matches(record);
  const interested = record => record.interests.some(interest => !interest.valid || interest.valid());
  const priorityOf = (id, interest) => interest.priority ?? acquisition.priority(interest.foregroundId ?? id);

  function retire(record) {
    records.delete(record.id);
    acquisition.cancel(record.key);
    clearTimeout(record.deadline); record.deadline = null;
    detach(record.image); record.image = null;
    record.finish?.();
  }

  function reconcile(id) {
    let record = records.get(id);
    const identity = identityFor(id);
    if (record && !matches(record, identity)) { retire(record); record = null; }
    return { record, identity };
  }

  function retryWaiting() {
    cancelRetry = null;
    if (disposed) return;
    for (const record of [...records.values()]) {
      if (record.state !== "waiting") continue;
      record.state = "idle";
      request(record.id);
    }
    bump();
  }

  function request(id, interest = {}) {
    if (disposed) return;
    const kind = kindOf(id);
    if (kind === "audio" || kind === "video" && knownSize(id)) {
      // Nothing to measure: the native display owns this resource's lifetime.
      if (!interest.onStart || interest.valid && !interest.valid()) return;
      const priority = priorityOf(id, interest), src = imageRequestUrl(srcFor(id), priority, interest.nonce);
      if (src) interest.onStart({ src, priority });
      return;
    }
    if (typeof Image === "undefined") return; // headless (unit tests)
    let { record, identity } = reconcile(id);
    if (identity == null) return;
    if (!record) {
      record = { id, identity, context, key: Symbol("media-resource"), state: "idle", attempts: 0, interests: [] };
      records.set(id, record);
    }
    record.interests = record.interests.filter(item => item.valid && item.valid());
    record.interests.push(interest);
    if (record.state === "ready" || record.state === "loading") {
      if (!interest.valid || interest.valid()) interest.onStart?.(record.request);
      return;
    }
    if (record.state !== "idle") return; // queued, waiting for its retry deadline, or terminal
    const src = srcFor(id);
    if (!src) { record.size = FAILURE_SIZE; record.state = "failed"; bump(); return; }
    record.state = "queued";
    acquisition.submit({ key: record.key, id: interest.foregroundId ?? id,
      priority: interest.priority, valid: () => current(record) && (record.state === "loading" || interested(record)),
      run: ({ priority, release }) => new Promise(resolve => {
        const video = kind === "video";
        let el = null;
        record.state = "loading";
        record.request = { src: imageRequestUrl(src, priority, interest.nonce ?? (record.attempts ? Date.now() : null)), priority };
        record.finish = () => { record.finish = null; release(); resolve(); };
        const settle = success => {
          // Interest gates admission, not completion: a freeze/re-window
          // cannot strand an already-started resource or its policy slot.
          if (records.get(id) !== record || record.image !== el) return;
          if (!current(record)) { retire(record); bump(); return; }
          const w = video ? el?.videoWidth : el?.naturalWidth, h = video ? el?.videoHeight : el?.naturalHeight;
          clearTimeout(record.deadline); record.deadline = null;
          const measured = success && validDims(w, h);
          // A decoded image probe keeps its bytes available to the display;
          // a video probe or a failed attempt retires its native consumer.
          if (measured && !video) el.onload = el.onerror = null; else detach(el);
          record.image = null;
          const known = knownSize(id);
          if (measured) { record.size = { w, h }; record.state = "ready"; }
          // Authoritative dimensions that arrived during this attempt settle
          // it: an already ready card is never resized into a fallback.
          else if (known) { record.size = known; record.state = "ready"; }
          else if (++record.attempts < 2) { record.state = "waiting"; cancelRetry = scheduleRetry(retryWaiting); }
          else { record.size = FAILURE_SIZE; record.state = "failed"; }
          record.finish();
          bump();
        };
        try {
          el = video ? document.createElement("video") : new Image();
          if (video) el.preload = "metadata";
        } catch { el = null; record.image = null; settle(false); return; }
        record.image = el;
        if (!video) { el.decoding = "async"; el.fetchPriority = priority === "background" ? "low" : "auto"; }
        if (video) el.onloadedmetadata = () => settle(true); else el.onload = () => settle(true);
        el.onerror = () => settle(false);
        record.deadline = setTimeout(() => {
          record.deadline = null;
          if (records.get(id) !== record || record.image !== el) return;
          if (current(record)) settle(false);
          else { retire(record); bump(); }
        }, MEASURE_TIMEOUT_MS);
        try { el.src = record.request.src; } catch { settle(false); return; }
        for (const item of record.interests) if (!item.valid || item.valid()) item.onStart?.(record.request);
      }) }).then(result => {
        if (result?.retired && current(record) && record.state === "queued") { record.state = "idle"; }
      });
  }

  // A completed probe does not grant a later native <img> a free fetch:
  // cache validation is still network work. Each mounted image display
  // registers its actual lifetime with the SAME policy as the probes.
  // abort retires a directly owned native element; a reactive consumer
  // (MediaBox) retires its element when the published src becomes null,
  // in the same synchronous flush, before any replacement fetch can start.
  // An unscoped display (a modal surface, not a source entry) has no source
  // context or content identity: only its owner's disposal retires it.
  function display({ id, src, foregroundId = id, priority = undefined, scoped = true, abort = () => {} }) {
    const identity = scoped ? identityFor(id) : id, owner = context, key = Symbol("image-display");
    let active = !disposed, finish = null;
    const [read, publish] = createSignal({ src: null, priority: "background" });
    const live = () => active && !disposed && (!scoped || context === owner && identityFor(id) === identity);
    const loaded = () => { const done = finish; finish = null; done?.(); };
    const lease = { read, loaded, scoped, dispose() {
      if (!active) return;
      active = false; displays.delete(lease);
      acquisition.cancel(key);
      // Abort the actual native consumer before releasing its capacity.
      abort(); publish({ src: null, priority: "background" }); loaded();
    }, current: live };
    if (!active || identity == null || !src) return lease;
    displays.add(lease);
    acquisition.submit({ key, id: foregroundId, priority, scoped, valid: live,
      run: ({ priority, release }) => new Promise(resolve => {
        finish = () => { release(); resolve(); };
        publish({ src: imageRequestUrl(src, priority), priority });
      }) });
    return lease;
  }

  function setContext(next) {
    if (context === next && !disposed) return;
    context = next;
    cancelRetry?.(); cancelRetry = null;
    for (const lease of [...displays]) if (lease.scoped) lease.dispose();
    for (const record of [...records.values()]) retire(record);
    bump();
  }

  return {
    request, display, setContext,
    reconcile() {
      for (const id of [...records.keys()]) reconcile(id);
      for (const lease of [...displays]) if (!lease.current()) lease.dispose();
      acquisition.reconcile();
    },
    sizeOf(id) { version(); const record = records.get(id); return record && current(record) ? record.size ?? null : null; },
    loadFailed(id) { version(); const record = records.get(id); return !!record && current(record) && record.state === "failed"; },
    retry(id, interest) { const { record } = reconcile(id); if (record) { retire(record); bump(); } request(id, interest); },
    dispose() {
      if (disposed) return;
      cancelRetry?.(); cancelRetry = null;
      for (const lease of [...displays]) lease.dispose();
      for (const record of [...records.values()]) retire(record);
      disposed = true; bump();
    },
  };
}

// A mechanical view registration, like Grid's viewport seam. The Store owns
// work and state; this adapter only binds inputs and owner-disposed interest.
export function useMeasuredSrc(register, input) {
  const [binding, setBinding] = createSignal(null);
  createEffect(() => {
    const lease = register(input());
    setBinding(() => lease);
    onCleanup(() => lease.dispose());
  });
  return () => binding()?.read() ?? { size: "pending", src: null, priority: "background" };
}

// Mechanical mounted-image seam: views render the admitted URL and forward
// native terminal events; the resource owner holds admission until then.
// element (optional) is a directly owned native <img> to abort on retirement.
// lazy registers only while that element is near the viewport: the policy,
// not the browser's own lazy loading, then decides when its bytes start.
export function useImageDisplay(register, input, element = () => null, { lazy = false } = {}) {
  const [binding, setBinding] = createSignal(null);
  const [near, setNear] = createSignal(!lazy);
  if (lazy) onMount(() => {
    const el = element();
    if (!el || typeof IntersectionObserver === "undefined") { setNear(true); return; }
    const observer = new IntersectionObserver(entries => setNear(entries.some(entry => entry.isIntersecting)), { rootMargin: "200px" });
    observer.observe(el);
    onCleanup(() => observer.disconnect());
  });
  const value = createMemo(input, undefined, { equals: (a, b) => !!a &&
    a.id === b.id && a.src === b.src && a.foregroundId === b.foregroundId && a.identity === b.identity && a.priority === b.priority });
  // The URL whose terminal event this element already delivered. Re-binding the
  // same element to that same URL (e.g. first-hash enrichment) starts no native
  // load and therefore can never deliver another terminal event: it renders
  // without a lease instead of holding policy capacity that nothing releases.
  let settled = null;
  createEffect(() => {
    const next = value();
    if (next.id == null || !near()) { settled = null; setBinding(null); return; } // no acquisition identity / not near
    if (settled && next.src === settled.input) {
      const shown = { src: settled.src, priority: settled.priority };
      setBinding(() => ({ read: () => shown })); return;
    }
    settled = null;
    const lease = register({ ...next, abort: () => element()?.removeAttribute("src") });
    setBinding(() => lease);
    onCleanup(() => lease.dispose());
  });
  const read = () => binding()?.read() ?? (value().id == null ? { src: value().src, priority: "foreground" } : { src: null, priority: "background" });
  return {
    read,
    loaded: () => {
      const shown = read();
      if (shown.src != null) settled = { input: value().src, src: shown.src, priority: shown.priority };
      binding()?.loaded?.();
    },
  };
}
