import { assert, assertEquals } from "jsr:@std/assert";
import { makeAcquisition } from "../client-solid/store/acquisition.js";
import { makeImageMeasurements, useImageDisplay, nativeResourceDeadline, ERROR_RETRY_MS, MEASURE_TIMEOUT_MS } from "../client-solid/lib/img-measure.js";
import { createRoot, createSignal } from "solid-js";

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
Deno.test("native resource deadline: bounded once, with settlement and retirement fencing late callbacks", () => {
  const originalTimeout = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  const callbacks = [], cleared = []; let expiries = 0;
  globalThis.setTimeout = (callback, delay) => { assertEquals(delay, MEASURE_TIMEOUT_MS); callbacks.push(callback); return callbacks.length; };
  globalThis.clearTimeout = timer => cleared.push(timer);
  try {
    const settle = nativeResourceDeadline(() => expiries++);
    settle(); callbacks[0](); assertEquals(expiries, 0);
    const retire = nativeResourceDeadline(() => expiries++);
    retire(); callbacks[1](); assertEquals(expiries, 0);
    const expire = nativeResourceDeadline(() => expiries++);
    callbacks[2](); callbacks[2](); assertEquals(expiries, 1);
    expire(); assertEquals(cleared, [1, 2, 3]);
  } finally { globalThis.setTimeout = originalTimeout; globalThis.clearTimeout = originalClear; }
});
function fixture(policyOptions = {}) {
  const original = globalThis.Image, images = [], idle = new Map();
  let sequence = 0;
  globalThis.Image = class {
    constructor() { images.push(this); this.naturalWidth = 640; this.naturalHeight = 360; }
    removeAttribute() { this.src = ""; }
  };
  const acquisition = makeAcquisition({ scheduleIdle: callback => { const key = ++sequence; idle.set(key, callback); return () => idle.delete(key); }, ...policyOptions });
  const context = {}, identities = new Map();
  acquisition.setContext(context);
  acquisition.setWindow({ ids: ["front"], currentId: "front" });
  const measurements = makeImageMeasurements({ acquisition, srcFor: id => `/bytes/${id}`, identityFor: id => identities.get(id) ?? "original" });
  measurements.setContext(context);
  return { acquisition, measurements, images, identities,
    idle() { const next = idle.entries().next().value; assert(next); idle.delete(next[0]); next[1]({ timeRemaining: () => 8 }); },
    dispose() { measurements.dispose(); acquisition.dispose(); if (original === undefined) delete globalThis.Image; else globalThis.Image = original; } };
}

Deno.test("image resources: feed sizes, src and inline interests share retained resources and the background cap", async () => {
  const f = fixture(), starts = [];
  try {
    f.measurements.request("background-size");
    f.measurements.request("background-inline", { onStart: request => starts.push(request) });
    f.measurements.request("background-src");
    f.measurements.request("front", { onStart: request => starts.push(request) });
    f.measurements.request("front", { onStart: request => starts.push(request) });
    assertEquals(f.images.length, 1, "size and src interests reuse the retained foreground Image");
    assertEquals(starts.length, 2);
    assertEquals(f.images[0].fetchPriority, "auto");
    f.images[0].onload(); await flush(); f.idle();
    assertEquals(f.images.length, 3, "only two background image resources start");
    assert(f.images.slice(1).every(image => image.fetchPriority === "low" && image.src.includes("priority=background")));
    f.images[1].onload(); await flush(); f.idle();
    assertEquals(f.images.length, 4);
    f.images[2].onload(); f.images[3].onload();
    assertEquals(f.measurements.sizeOf("background-inline"), { w: 640, h: 360 });
  } finally { f.dispose(); }
});

Deno.test("image resources: gesture freezes queued starts and retirement releases aborted capacity before replacements", async () => {
  const f = fixture();
  try {
    f.measurements.request("front");
    const stale = f.images[0].onload;
    f.identities.set("front", "replacement");
    f.measurements.reconcile();
    assertEquals(f.images[0].src, "");
    f.measurements.request("front");
    assertEquals(f.images.length, 2);
    stale(); assertEquals(f.measurements.sizeOf("front"), null);
    f.acquisition.setGesture(true);
    f.measurements.request("background");
    f.images[1].onload(); await flush();
    assertEquals(f.images.length, 2);
    f.acquisition.setGesture(false); f.idle();
    assertEquals(f.images.length, 3);
    const retired = f.images[2].onload;
    f.acquisition.setContext({}); f.measurements.setContext({});
    retired(); assertEquals(f.measurements.sizeOf("background"), null);
  } finally { f.dispose(); }
});

Deno.test("image resources: waiting is an admission state until the shared retry deadline; replacement clears a failed result", async () => {
  const f = fixture(), originalTimeout = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  let fire;
  // Only the shared retry timer is captured; per-attempt deadlines stay pending.
  globalThis.setTimeout = (callback, delay) => { if (delay === ERROR_RETRY_MS) fire = callback; else assertEquals(delay, MEASURE_TIMEOUT_MS); return 999; };
  globalThis.clearTimeout = () => {};
  try {
    f.measurements.request("front"); f.images[0].onerror(); await flush();
    for (let i = 0; i < 50; i++) { f.measurements.reconcile(); f.measurements.request("front"); }
    assertEquals(f.images.length, 1, "landings cannot retry before the deadline");
    fire(); assertEquals(f.images.length, 2);
    assert(f.images[1].src.includes("_r="), "retry bypasses a partial cached response");
    f.images[1].onerror(); await flush();
    assertEquals(f.measurements.loadFailed("front"), true);
    f.identities.set("front", "new content");
    f.measurements.request("front"); assertEquals(f.images.length, 3);
    f.images[2].onload(); assertEquals(f.measurements.sizeOf("front"), { w: 640, h: 360 });
  } finally { f.dispose(); globalThis.setTimeout = originalTimeout; globalThis.clearTimeout = originalClear; }
});

Deno.test("image resources: an admitted Image finishes after its originating interest retires and frees the background lane", async () => {
  const f = fixture();
  let interested = true;
  try {
    f.measurements.request("front", { valid: () => interested });
    interested = false; // a src ripple freezes; already-started work survives
    f.measurements.request("background");
    f.images[0].onload(); await flush();
    assertEquals(f.measurements.sizeOf("front"), { w: 640, h: 360 });
    f.idle(); assertEquals(f.images.length, 2, "finished foreground demand cannot strand idle work");
    f.measurements.request("front");
    assertEquals(f.images.length, 2, "a later interest reuses the completed resource");
    f.images[1].onload();
  } finally { f.dispose(); }
});

Deno.test("image resources: ready measurements cannot publish feed or inline DOM requests outside shared capacity", async () => {
  const f = fixture();
  const displays = [];
  try {
    for (const id of ["feed", "inline"]) {
      f.measurements.request(id); f.idle(); f.images.at(-1).onload(); await flush();
    }
    f.measurements.request("held-a"); f.measurements.request("held-b"); f.idle();
    for (const id of ["feed", "inline"]) displays.push(f.measurements.display({ id, src: `/bytes/${id}?priority=background`, abort() {} }));
    assert(displays.every(display => display.read().src === null), "two native measurements occupy both background slots");
    f.images[2].onload(); await flush(); f.idle();
    assert(displays[0].read().src?.includes("priority=background"));
    assertEquals(displays[1].read().src, null, "a ready inline resource cannot bypass an active feed display");
    displays[0].loaded(); await flush(); f.idle();
    assert(displays[1].read().src?.includes("priority=background"));
    displays[1].loaded(); f.images[3].onload();
  } finally { displays.forEach(display => display.dispose()); f.dispose(); }
});

Deno.test("image resources: displayed content retirement aborts before replacement admission and fences late events", async () => {
  const f = fixture(); let aborts = 0;
  try {
    const old = f.measurements.display({ id: "front", src: "/bytes/front", abort: () => aborts++ });
    assertEquals(old.read().src, "/bytes/front");
    f.identities.set("front", "new"); f.measurements.reconcile();
    assertEquals(aborts, 1); assertEquals(old.read().src, null);
    const next = f.measurements.display({ id: "front", src: "/bytes/front", abort: () => aborts++ });
    assertEquals(next.read().src, "/bytes/front");
    old.loaded(); next.loaded();
    old.dispose(); next.dispose();
    assertEquals(aborts, 2, "the native element retires once, even after load");
  } finally { f.dispose(); }
});

Deno.test("media resources: audio and known-size video srcs start without a native probe; unknown video probes metadata", async () => {
  const original = { Image: globalThis.Image, document: globalThis.document };
  const made = [];
  globalThis.Image = class { constructor() { made.push(this); } removeAttribute() { this.src = ""; } };
  globalThis.document = { createElement(tag) {
    const el = { tagName: tag.toUpperCase(), pause() {}, load() {}, removeAttribute() { this.src = ""; } };
    made.push(el); return el;
  } };
  const acquisition = makeAcquisition({ scheduleIdle: () => () => {} });
  acquisition.setWindow({ ids: ["song", "clip", "unknown"], currentId: "song" });
  const kinds = { song: "audio", clip: "video", unknown: "video" };
  const measurements = makeImageMeasurements({ acquisition, srcFor: id => `/bytes/${id}`, kindOf: id => kinds[id],
    knownSize: id => id === "clip" ? { w: 640, h: 360 } : null });
  try {
    const starts = [];
    measurements.request("song", { onStart: request => starts.push(request.src) });
    measurements.request("clip", { onStart: request => starts.push(request.src) });
    assertEquals(starts, ["/bytes/song", "/bytes/clip"]);
    assertEquals(made.length, 0, "nothing to measure: the native display owns the load");
    measurements.request("unknown", { onStart: request => starts.push(request.src) });
    assertEquals(made.map(el => [el.tagName, el.preload]), [["VIDEO", "metadata"]]);
    made[0].videoWidth = 320; made[0].videoHeight = 180; made[0].onloadedmetadata();
    assertEquals(measurements.sizeOf("unknown"), { w: 320, h: 180 });
    assertEquals(made[0].src, "", "a finished video probe retires its native consumer");
  } finally {
    measurements.dispose(); acquisition.dispose();
    for (const [key, value] of Object.entries(original)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
});

Deno.test("surface displays: foreground admission that survives source context changes until the owner disposes it", async () => {
  const f = fixture();
  try {
    f.measurements.request("held-a"); f.measurements.request("held-b"); f.idle();
    const thumb = f.measurements.display({ id: "/thumb/a", src: "/thumb/a", foregroundId: null, priority: "foreground", scoped: false });
    assertEquals(thumb.read(), { src: "/thumb/a", priority: "foreground" }, "user-visible surface work is not idle-scheduled");
    const queued = f.measurements.display({ id: "/thumb/b", src: "/thumb/b", foregroundId: null, priority: "foreground", scoped: false });
    const next = {};
    f.acquisition.setContext(next); f.measurements.setContext(next);
    assertEquals(thumb.read().src, "/thumb/a", "a source change does not retire a modal surface");
    assertEquals(queued.read().src, "/thumb/b");
    thumb.loaded(); queued.loaded();
    thumb.dispose(); queued.dispose();
    assertEquals(thumb.read().src, null);
  } finally { f.dispose(); }
});

Deno.test("display seam: re-binding a settled element to the same URL holds no capacity that no native event could release", async () => {
  const f = fixture();
  try {
    let display, setIdentity, dispose;
    createRoot(cleanup => {
      dispose = cleanup;
      const [identity, set] = createSignal("");
      setIdentity = set;
      display = useImageDisplay(input => f.measurements.display(input), () => ({ id: "front", src: "/bytes/front", identity: identity() }));
    });
    await flush();
    assertEquals(display.read().src, "/bytes/front");
    display.loaded(); // the native element finished this exact URL
    setIdentity("first-hash"); await flush();
    assertEquals(display.read().src, "/bytes/front", "the same element keeps its loaded URL");
    const held = ["a", "b", "c", "d", "e", "f"].map(id => f.measurements.display({ id: "front", src: `/bytes/${id}` }));
    assert(held.every(lease => lease.read().src !== null), "all six foreground slots remain available");
    held.forEach(lease => lease.dispose());
    dispose();
  } finally { f.dispose(); }
});

Deno.test("display seam: live admission ranks never become native registration dependencies", async () => {
  const f = fixture();
  let dispose, setRank, display, registrations = 0;
  try {
    f.measurements.display({ id: "second", src: "/bytes/second", priority: "background" });
    createRoot(cleanup => {
      dispose = cleanup;
      const [rank, set] = createSignal(0); setRank = set;
      display = useImageDisplay(input => { registrations++; return f.measurements.display(input); },
        () => ({ id: "front", src: "/bytes/front", order: rank }));
    });
    await flush();
    assertEquals(display.read().src, "/bytes/front");
    setRank(10); await flush();
    assertEquals(registrations, 1, "changing demand rank cannot re-register or abort an active native consumer");
    display.loaded();
  } finally { dispose?.(); f.dispose(); }
});

Deno.test("surface displays: features receive the Store's one display port at installation", async () => {
  const { makeAppStore } = await import("../client-solid/store/app-store.js");
  const location = globalThis.location, history = globalThis.history;
  const requestIdle = globalThis.requestIdleCallback, cancelIdle = globalThis.cancelIdleCallback;
  const idle = new Map(); let sequence = 0;
  globalThis.requestIdleCallback = callback => { const id = ++sequence; idle.set(id, callback); return id; };
  globalThis.cancelIdleCallback = id => idle.delete(id);
  globalThis.location = { pathname: "/", search: "", hash: "" };
  globalThis.history = { state: null, replaceState() {}, pushState() {} };
  const store = makeAppStore({ subscribeSources: null });
  let port = null;
  try {
    store.actions.features.register({ name: "surface-probe", install: context => { port = context.surfaceDisplay; } });
    assertEquals(typeof port, "function");
    const lease = port({ id: "/thumb.png", src: "/thumb.png" });
    assertEquals(lease.read(), { src: "/thumb.png", priority: "foreground" }, "admitted as user-visible foreground work");
    const preloads = [0, 1, 2].map(i => port({ id: `/ahead-${i}`, src: `/ahead-${i}`, priority: "background" }));
    assert(preloads.every(item => item.read().src === null), "surface preloads wait behind foreground demand");
    lease.loaded(); await flush();
    const [id, callback] = idle.entries().next().value;
    idle.delete(id); callback({ timeRemaining: () => 8 });
    assertEquals(preloads.map(item => item.read().src), ["/ahead-0?priority=background", "/ahead-1?priority=background", null],
      "the feature port preserves background intent and the two-slot ceiling");
    preloads.forEach(item => item.dispose()); lease.dispose();
    for (const [id, callback] of idle) { idle.delete(id); callback({ timeRemaining: () => 8 }); }
    assert(preloads.every(item => item.read().src === null), "retired owners cannot start in a pending idle turn");
  } finally {
    store.dispose();
    if (location === undefined) delete globalThis.location; else globalThis.location = location;
    if (history === undefined) delete globalThis.history; else globalThis.history = history;
    if (requestIdle === undefined) delete globalThis.requestIdleCallback; else globalThis.requestIdleCallback = requestIdle;
    if (cancelIdle === undefined) delete globalThis.cancelIdleCallback; else globalThis.cancelIdleCallback = cancelIdle;
  }
});


Deno.test("image resources: probes and mounted/thumbnail displays share the app-origin transport budget", async () => {
  const f = fixture({ appOrigin: "http://engine.test" }), displays = [];
  try {
    f.acquisition.setWindow({ ids: ["a", "b", "c", "d"], currentId: "a" });
    for (const id of ["a", "b", "c", "d"]) f.measurements.request(id);
    assertEquals(f.images.length, 4);
    displays.push(f.measurements.display({ id: "thumb", src: "/thumb.png", priority: "foreground", scoped: false }));
    assertEquals(displays[0].read().src, null, "a display cannot bypass four active native probes");
    f.images[0].onload(); await flush();
    assertEquals(displays[0].read().src, "/thumb.png");
    displays.push(f.measurements.display({ id: "foreign", src: "http://other.test/img.png", priority: "foreground", scoped: false }));
    assertEquals(displays[1].read().src, "http://other.test/img.png");
  } finally { displays.forEach(display => display.dispose()); f.dispose(); }
});

Deno.test("image resources: a probe of an already sized entry notifies only its own size readers, never a feed-wide derivation", async () => {
  const f = fixture();
  const { createMemo } = await import("solid-js");
  const ids = Array.from({ length: 2000 }, (_, i) => `entry-${i}`);
  const known = new Set(ids.slice(1)); // every entry but one has authoritative listing dimensions
  const m = makeImageMeasurements({ acquisition: f.acquisition, srcFor: id => `/bytes/${id}`,
    knownSize: id => known.has(id) ? { w: 640, h: 360 } : null });
  m.setContext({});
  let wide = 0, own = 0, dispose;
  try {
    createRoot(cleanup => {
      dispose = cleanup;
      // sizeFor's shape: failure first, then the listing's dimensions, else the measurement.
      createMemo(() => { wide++; return ids.filter(id => !m.loadFailed(id) && (known.has(id) || m.sizeOf(id))).length; });
      createMemo(() => { own++; return m.sizeOf("entry-7"); });
    });
    f.acquisition.setWindow({ ids, currentId: ids[0], limit: 20 });
    for (const id of ids.slice(0, 20)) m.request(id);
    await flush();
    const [wideBefore, ownBefore] = [wide, own];
    // listing-sized entries' probes settle as capacity frees; entry-0 stays loading
    for (let done = 1, guard = 0; done < 20 && guard < 50; guard++) {
      const started = f.images.length;
      for (const image of f.images.slice(done, started)) image.onload();
      done = started; await flush();
    }
    assertEquals(f.images.length, 20);
    assertEquals(wide, wideBefore, "a probe of an already sized entry changes nothing the feed derives");
    assertEquals(own, ownBefore + 1, "that entry's own size readers are notified");
    f.images[0].onload();                                    // the one unsized entry becomes ready
    assertEquals(wide, wideBefore + 1, "a real readiness change recomputes once");
    m.setContext({});                                        // a new context re-reads everything
    assertEquals(wide, wideBefore + 2);
  } finally { dispose?.(); m.dispose(); f.dispose(); }
});
