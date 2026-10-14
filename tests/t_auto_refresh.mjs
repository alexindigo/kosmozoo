import { assert, assertEquals } from "jsr:@std/assert";
import { createRoot, createSignal } from "solid-js";
import { makeAppStore } from "../client-solid/store/app-store.js";
import { api } from "../client/js/api.mjs";
import { clientInventory } from "./helpers/client-inventory.mjs";
import { sourceFrame, injectedSourceStream } from "./helpers/source-stream.mjs";
import { Jobs } from "../src/jobs.mjs";
import { makeSourceFreshness } from "../client-solid/store/source-freshness.js";
import { makeSizes, scheduleRetry, ERROR_RETRY_MS } from "../client-solid/store/sizes.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => resolve = yes);
  return { promise, resolve };
};
const waitFor = async (predicate, timeout = 1800) => {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("Consumer outcome was not observed");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

async function withClient(run, prepare = () => {}) {
  const saved = { ...api }, oldLocation = globalThis.location, oldHistory = globalThis.history;
  globalThis.location = { pathname: "/", search: "", hash: "" };
  globalThis.history = { state: null, replaceState(_state, _title, href) {
    const next = new URL(href, "http://fixture");
    Object.assign(globalThis.location, { pathname: next.pathname, search: next.search, hash: next.hash });
  }, pushState(_state, _title, href) { this.replaceState(_state, _title, href); } };
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const sources = { h: { address: "mock:1", kind: "comfy", online: true, pinned: false, autoRefresh: true } };
  const activity = { supported: true, state: "idle", epoch: "E", terminalRevision: 0, resyncRevision: 0 };
  const row = (name) => ({ name, size: 100, hash: null, width: 100, height: 50, meta: null, judgment: null, extracted: false });
  const rows = [row("a.png"), row("b.png")];
  let stream, revision = 0;
  const frame = () => sourceFrame({ h: { ...sources.h, activity } }, revision++);
  const emit = async (snapshot = null) => {
    if (snapshot) Object.assign(activity, snapshot);
    stream.snapshot(frame());
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };
  api.collections = async () => structuredClone(sources);
  api.patchCollection = async (_id, patch) => {
    Object.assign(sources.h, patch);
    sources.h.attributesRevision = (sources.h.attributesRevision ?? 0) + 1;
    sources.h.sourceVersion = sourceFrame(sources).sources.h.sourceVersion;
    return { ...sources.h };
  };
  api.entries = async () => structuredClone(rows);
  api.inventory = async (id) => clientInventory(await api.entries(id), { coverage: "recursive" });
  api.meta = async () => ({ changed: false, pending: 0 });
  api.want = async () => ({ pending: 0 });
  api.nodes = async () => ({});
  api.settings = async () => ({});
  api.setSettings = async () => ({});
  api.prefetch = async () => ({ pending: {} });
  let dispose;
  const store = createRoot((cleanup) => {
    dispose = cleanup;
    return makeAppStore({ subscribeSources: callbacks => stream.subscribe(callbacks), storage });
  });
  try {
    await prepare({ store, sources, activity, rows, row });
    const initial = frame();
    Object.assign(sources.h, { incarnation: initial.sources.h.incarnation, sourceVersion: initial.sources.h.sourceVersion });
    stream = injectedSourceStream(initial);
    const boot = store.actions.boot();
    await run({ store, sources, activity, rows, row, boot, emit });
  } finally {
    store.actions.status.clear("transient");
    store.dispose(); dispose(); Object.assign(api, saved);
    if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation;
    if (oldHistory === undefined) delete globalThis.history; else globalThis.history = oldHistory;
  }
}

Deno.test("automatic freshness: a failed initial inventory remains pending and recovers without a new completion", async () => {
  let reads = 0;
  await withClient(async ({ store, boot }) => {
    await boot;
    assertEquals(store.state.images.length, 0);
    await waitFor(() => store.state.images.length === 2);
    assertEquals(reads, 2);
    assertEquals(store.state.sourceActivity.h.terminalRevision, 0, "recovery must not fabricate a finish");
  }, ({ rows }) => {
    api.entries = async () => { reads++; if (reads === 1) throw new Error("initial inventory 502"); return rows; };
  });
});

Deno.test("automatic freshness: enabling refresh reconciles an already-reported completion while another job runs", async () => {
  await withClient(async ({ store, activity, rows, row, boot, emit }) => {
    await boot;
    const current = store.state.current();
    await store.actions.hosts.patch("h", { autoRefresh: false });
    rows.unshift(row("finished.png"));
    Object.assign(activity, { state: "running", runningCount: 1, runningPromptId: "next-job", terminalRevision: 1 });
    await emit();
    assert(!store.state.images.some((image) => image.filename === "finished.png"));
    await store.actions.hosts.patch("h", { autoRefresh: true });
    await waitFor(() => store.state.images.some((image) => image.filename === "finished.png"), 300);
    assertEquals(store.state.current(), current);
    assertEquals(store.state.sourceActivity.h.state, "running");
  });
});

Deno.test("initial acceptance: recovery restores the captured navigation once through the shared inventory lane", async () => {
  const restores = [];
  let reads = 0;
  await withClient(async ({ store, boot }) => {
    await boot;
    await waitFor(() => store.state.images.length === 2);
    assertEquals(store.state.current().image, "b.png");
    assertEquals(restores, [1], "first successful acceptance, not the failed original invocation, owns restore");
  }, ({ store, rows }) => {
    globalThis.location.hash = "#h#b.png";
    api.entries = async () => { reads++; if (reads === 1) throw new Error("initial inventory 502"); return rows; };
    store.actions.feed.register({ scrollEl: { clientWidth: 100, clientHeight: 200, scrollTop: 0 },
      virtualizer: { scrollToIndex: (index) => restores.push(index), getVirtualItems: () => [] } });
  });
});

Deno.test("automatic freshness: confirmed completion reaches the feed before optional progress telemetry settles", async () => {
  const progress = deferred(), events = [];
  let held = false, sampling = false;
  const history = [{ id: "old", terminal: true, outcome: "success" }];
  let running = "first-job";
  const jobs = new Jobs({ hosts: { h: "mock:1" }, onFinish: (_address, _sources, snapshot) => events.push(snapshot),
    client: () => ({ queue: async () => ({ running: [running], pending: [] }), history: async () => [...history],
      logs: async () => { if (held) { sampling = true; return progress.promise; } return { entries: [], size: 0 }; } }) });
  await jobs.tick();
  let tick;
  try {
    await withClient(async ({ store, rows, row, boot, emit }) => {
      await boot;
      rows.unshift(row("first-job-output.png"));
      history.push({ id: "first-job", terminal: true, outcome: "success" });
      running = "next-job"; held = true;
      tick = jobs.tick();
      await waitFor(() => sampling, 300);
      await emit(jobs.snapshot("h"));
      await waitFor(() => store.state.images.some((image) => image.filename === "first-job-output.png"), 300);
      assertEquals(events.length, 1);
      assertEquals(jobs.snapshot("h").state, "running");
      assertEquals(jobs.snapshot("h").terminalRevision, 1);
    }, ({ activity }) => {
      Object.assign(activity, jobs.snapshot("h"));
    });
  } finally {
    progress.resolve({ entries: [], size: 0 }); await tick; await jobs.stop();
  }
  assertEquals(events.length, 1, "later progress must not notify the same finish twice");
});

Deno.test("completion monitoring: a pending progress sample cannot prevent observing the next completed job", async () => {
  const held = deferred(), events = [];
  let sampled = false, running = "A";
  const history = [{ id: "old", terminal: true, outcome: "success" }];
  const jobs = new Jobs({ hosts: { h: "mock:1" }, onFinish: (_address, _sources, snapshot) => events.push(snapshot),
    client: () => ({ queue: async () => ({ running: [running], pending: [] }), history: async () => [...history],
      logs: async () => { sampled = true; return held.promise; } }) });
  const first = jobs.tick();
  let next;
  try {
    await waitFor(() => sampled, 300);
    history.push({ id: "A", terminal: true, outcome: "success" });
    running = "B";
    next = jobs.tick();
    await waitFor(() => jobs.snapshot("h").terminalRevision === 1, 300);
    assertEquals(jobs.snapshot("h").runningPromptId, "B");
    assertEquals(events.length, 1);
  } finally {
    held.resolve({ entries: [{ t: 1, m: "A 9/10" }], size: 1 });
    await Promise.all([first, next]); await jobs.stop();
  }
  assertEquals(jobs.snapshot("h").progress, null, "retired A progress cannot decorate B");
});

Deno.test("viewport acquisition: late coherent range admits images without scrolling or current changes", async () => {
  await withClient(async ({ store, boot }) => {
    await boot;
    const [items, setItems] = createSignal([]);
    const col = { clientWidth: 100, clientHeight: 200, scrollTop: 0 };
    store.actions.feed.register({ scrollEl: col, virtualizer: { scrollToIndex() {}, getVirtualItems: items } });
    const first = store.state.images[0], before = store.state.current();
    assertEquals(store.state.window.getSrc(0, first), null);
    setItems(store.state.images.map((image, index) => ({ key: image.id, index, start: index * 100, end: (index + 1) * 100 })));
    await waitFor(() => store.state.window.getSrc(0, first) !== null, 300);
    assertEquals(store.state.current(), before);
    assertEquals(store.state.feedActivity(), "settled");
  });
});

Deno.test("viewport acquisition: zero geometry stays pending and a late viewport size admits the same range", async () => {
  await withClient(async ({ store, boot }) => {
    await boot;
    const [height, setHeight] = createSignal(0);
    const col = { clientWidth: 100, clientHeight: 0, scrollTop: 0 };
    const items = store.state.images.map((image, index) => ({ key: image.id, index, start: index * 100, end: (index + 1) * 100 }));
    store.actions.feed.register({ scrollEl: col, virtualizer: { scrollToIndex() {}, getVirtualItems: () => items },
      viewport: () => ({ width: 100, height: height(), items }) });
    const first = store.state.images[0];
    assertEquals(store.state.window.getSrc(0, first), null);
    col.clientHeight = 200; setHeight(200);
    await waitFor(() => store.state.window.getSrc(0, first) !== null, 300);
  });
});

Deno.test("freshness ownership: unknown, forged, foreign and older read tickets cannot acknowledge newer work", () => {
  const owner = makeSourceFreshness(), other = makeSourceFreshness();
  const unknown = owner.capture();
  owner.observe({ supported: true, state: "running", epoch: "E", terminalRevision: 1, resyncRevision: 0 });
  assertEquals(owner.accept(unknown), false);
  assert(owner.pending());
  assertEquals(owner.accept({ sequence: 999, target: owner.target() }), false);
  assertEquals(other.accept(owner.capture()), false);
  const older = owner.capture();
  owner.observe({ supported: true, state: "running", epoch: "E", terminalRevision: 2, resyncRevision: 0 });
  assert(owner.accept(owner.capture()));
  assertEquals(owner.accept(older), false);
  assertEquals(owner.pending(), false);
  assertEquals(owner.observe({ supported: true, state: "running", epoch: "E", terminalRevision: 1, resyncRevision: 0 }), false);
  const retired = owner.capture();
  owner.retire();
  assertEquals(owner.accept(retired), false);
  assertEquals(owner.pending(), false);
  assertEquals(owner.capture(), null);
});

Deno.test("acquisition retry ownership: one shared timer retains each owner's work and retirement cancels only its own callback", () => {
  const originalTimeout = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  let fire, scheduled = 0;
  const observed = [];
  globalThis.setTimeout = (callback, delay) => { assertEquals(delay, ERROR_RETRY_MS); fire = callback; scheduled++; return 999; };
  globalThis.clearTimeout = () => {};
  let cancelA, cancelB;
  try {
    cancelA = scheduleRetry(() => observed.push("size"));
    cancelB = scheduleRetry(() => observed.push("src"));
    assertEquals(scheduled, 1);
    fire();
    assertEquals(observed, ["size", "src"], "a shared deadline must deliver both owners' pending acquisition");
    observed.length = 0;
    cancelA = scheduleRetry(() => observed.push("retired"));
    cancelB = scheduleRetry(() => observed.push("current"));
    assertEquals(scheduled, 2);
    cancelA(); fire();
    assertEquals(observed, ["current"]);
  } finally { cancelA?.(); cancelB?.(); globalThis.setTimeout = originalTimeout; globalThis.clearTimeout = originalClear; }
});

Deno.test("automatic freshness: unchanged observations retain backoff and disabled work catches up on enablement", async () => {
  await withClient(async ({ store, rows, row, activity, boot, emit }) => {
    await boot;
    rows.unshift(row("pending.png"));
    let reads = 0;
    api.entries = async () => { reads++; if (reads === 1) throw new Error("refresh inventory 502"); return rows; };
    Object.assign(activity, { state: "running", terminalRevision: 1, runningCount: 1 });
    await emit();
    await waitFor(() => reads === 1);
    for (let i = 0; i < 10; i++) await emit();
    assertEquals(reads, 1, "no-op activity cannot turn retry backoff into rapid reads");
    await store.actions.hosts.patch("h", { autoRefresh: false });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assertEquals(reads, 1, "disabled automatic work is retained, not executed");
    await store.actions.hosts.patch("h", { autoRefresh: true });
    await waitFor(() => store.state.images.some((image) => image.filename === "pending.png"), 300);
    assertEquals(reads, 2);
  });
});

Deno.test("viewport ownership: loading-time motion settles acquisition without retroactively committing browsing", async () => {
  const metadata = deferred();
  try {
    await withClient(async ({ store, boot }) => {
      await waitFor(() => store.state.images.length === 2, 300);
      const current = store.state.current(), beforeUrl = globalThis.location.hash;
      const col = { clientWidth: 100, clientHeight: 100, scrollTop: 0 };
      const items = store.state.images.map((image, index) => ({ key: image.id, index, start: index * 100, end: (index + 1) * 100 }));
      store.actions.feed.register({ scrollEl: col, virtualizer: { scrollToIndex() {}, getVirtualItems: () => items } });
      col.scrollTop = 100; store.actions.feed.scrolled(100);
      assertEquals(store.state.feedActivity(), "scrolling");
      metadata.resolve({ changed: false, pending: 0 }); await boot;
      await waitFor(() => store.state.feedActivity() === "settled", 300);
      assertEquals(store.state.current(), current);
      assertEquals(globalThis.location.hash, beforeUrl);
    }, () => { api.meta = () => metadata.promise; });
  } finally { metadata.resolve({ changed: false, pending: 0 }); }
});

Deno.test("size acquisition: a retired source measurement cannot publish into an A→B→A replacement", async () => {
  const oldImage = globalThis.Image, probes = [];
  globalThis.Image = class {
    constructor() { this.naturalWidth = 64; this.naturalHeight = 32; probes.push(this); }
    removeAttribute() { this.src = ""; }
  };
  try {
    await withClient(async ({ store, rows, boot }) => {
      await boot;
      const first = probes.find((image) => image.src.includes("/h/entries/a.png/"));
      assert(first?.onload);
      const stale = first.onload;
      await store.actions.hosts.select("other");
      rows[0].hash = "replacement-content";
      await store.actions.hosts.select("h");
      stale();
      assertEquals(store.state.cardSize(0), null, "old dimensions must not make the replacement render-ready");
      const fresh = probes.filter((image) => image.src.includes("/h/entries/a.png/")).at(-1);
      assert(fresh !== first && fresh.onload);
      fresh.naturalWidth = 128; fresh.naturalHeight = 64; fresh.onload();
      assertEquals(store.state.cardSize(0), { w: 128, h: 64 });
    }, ({ sources, rows }) => {
      sources.other = { address: "other:1", kind: "comfy", online: true, autoRefresh: false };
      for (const row of rows) { row.width = null; row.height = null; }
    });
  } finally {
    if (oldImage === undefined) delete globalThis.Image; else globalThis.Image = oldImage;
  }
});

Deno.test("size acquisition: changed content retires stale slots before the shared concurrency gate", () => {
  const oldImage = globalThis.Image, probes = [];
  const entries = Array.from({ length: 6 }, (_, index) => ({ id: `h:${index}`, hash: "old" }));
  globalThis.Image = class {
    constructor() { this.naturalWidth = 64; this.naturalHeight = 32; probes.push(this); }
    removeAttribute() { this.src = ""; }
  };
  const sizes = makeSizes({ srcFor: (id) => `/bytes/${id}`, imageAt: (index) => entries[index],
    identityFor: (id) => entries.find((entry) => entry.id === id)?.hash ?? null });
  try {
    sizes.setContext({});
    const view = entries.map((_, index) => index);
    sizes.resolveAhead(view, 0, 5);
    assertEquals(probes.length, 6);
    const stale = probes.map((image) => image.onload);
    for (const entry of entries) entry.hash = "new";
    sizes.resolveAhead(view, 0, 5);
    assertEquals(probes.length, 12, "retired content must not occupy all slots and prevent replacement measurements");
    for (const callback of stale) callback();
    for (const entry of entries) assertEquals(sizes.sizeOf(entry.id), null);
    for (const image of probes.slice(6)) { image.naturalWidth = 128; image.naturalHeight = 64; image.onload(); }
    for (const entry of entries) assertEquals(sizes.sizeOf(entry.id), { w: 128, h: 64 });
  } finally {
    sizes.dispose();
    if (oldImage === undefined) delete globalThis.Image; else globalThis.Image = oldImage;
  }
});
