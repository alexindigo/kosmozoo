import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import { Jobs } from "../src/jobs.mjs";
import { mkStateRig, sourceContext, makeTestInventory } from "./helpers/rig.mjs";
import { validateSourceSnapshot, subscribeSources } from "../client/js/source-events.mjs";
import { sourceFrame, injectedSourceStream } from "./helpers/source-stream.mjs";
import { makeSourceFreshness } from "../client-solid/store/source-freshness.js";
import { makeAppStore } from "../client-solid/store/app-store.js";
import { api } from "../client/js/api.mjs";
import { clientInventory } from "./helpers/client-inventory.mjs";
import { createRoot } from "solid-js";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; };
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const nextFrame = async reader => {
  const decoder = new TextDecoder(); let text = "";
  while (!text.endsWith("\n\n")) { const chunk = await reader.read(); assert(!chunk.done); text += decoder.decode(chunk.value, { stream: true }); }
  return JSON.parse(text.split("\n").find(line => line.startsWith("data: ")).slice(6));
};

Deno.test("committed collection subscriptions: real changes, placeholders, versions and unsubscribe", async () => {
  const rig = await mkStateRig("source-events-store");
  const events = [];
  try {
    const unsubscribe = rig.store.subscribeCollections(event => {
      events.push(event);
      assertEquals(rig.store.collectionGet(event.id), event.row);
    });
    rig.store.collectionAdd("a", "mock:1");
    const inserted = rig.store.collectionRevision("a");
    rig.store.collectionAdd("a", "mock:1", { pinned: true });
    rig.store.collectionPatch("a", {});
    rig.store.collectionPatch("a", { pinned: false });
    assertEquals(events.length, 1);
    rig.store.collectionPatch("a", { pinned: true });
    assert(rig.store.collectionRevision("a") > inserted);
    rig.store.entryHide("placeholder", "x.png");
    assertEquals(events.at(-1).row.address, null);
    rig.store.collectionAdd("placeholder", "mock:2");
    assertEquals(rig.store.collectionGet("placeholder").address, null, "placeholder/add semantics remain INSERT OR IGNORE");
    rig.store.collectionRemove("a");
    assertEquals(events.at(-1), { id: "a", row: null, revision: rig.store.collectionRevision("a") });
    const count = events.length;
    rig.store.collectionRemove("a"); unsubscribe(); unsubscribe();
    rig.store.collectionAdd("a", "mock:1");
    assertEquals(events.length, count);
  } finally { await rig.close(); }
});

Deno.test("semantic Jobs subscription: timestamp silence, auxiliary progress and independent completion", async () => {
  let now = 0, logs = [], history = [], running = ["A"];
  const changes = [], finishes = [];
  const jobs = new Jobs({ hosts: { a: "mock:1", alias: "mock:1", folder: "folder:/fixture" }, clock: () => ++now,
    client: () => ({ queue: async () => ({ running, pending: [] }), history: async () => history,
      logs: async () => ({ entries: logs, size: logs.length }) }), onFinish: (...args) => finishes.push(args) });
  const settle = async () => { await jobs.tick(); for (let i = 0; i < 30; i++) await Promise.resolve(); };
  try {
    const unsubscribe = jobs.subscribe((address, sources, snapshot) => changes.push({ address, sources: [...sources], snapshot }));
    await settle(); const first = changes.length;
    await settle(); assertEquals(changes.length, first, "sampledAt-only churn is not publication");
    logs = [{ t: 1, m: "A 1/10" }]; await settle();
    logs = [{ t: 1, m: "A 2/10" }]; await settle();
    assertEquals(changes.at(-1).snapshot.progress.fraction, .2);
    assertEquals(finishes.length, 0, "auxiliary progress never invalidates inventory");
    history = [{ id: "A", terminal: true }]; running = ["B"]; await settle();
    assertEquals(finishes.length, 1);
    assertEquals(changes.at(-1).snapshot.runningPromptId, "B");
    assertEquals(changes.at(-1).snapshot.terminalRevision, 1);
    assertEquals(jobs.monitors.size, 1);
    unsubscribe(); const count = changes.length; running = []; await settle(); assertEquals(changes.length, count);
  } finally { await jobs.stop(); }
});

Deno.test("source registry: synchronous direct commits, same-address reincarnation, placeholders and cached bootstrap identity", async () => {
  const rig = await mkStateRig("source-registry");
  rig.store.collectionAdd("a", "mock:1"); rig.store.collectionAdd("alias", "mock:1");
  const hosts = rig.store.collectionMap();
  const ctx = sourceContext({ ...rig, hosts, inventory: makeTestInventory(hosts) });
  const first = ctx.sourceActivity.source("a"), oldToken = ctx.inventory.capture("a"), epoch = ctx.jobs.snapshot("alias").epoch;
  try {
    rig.store.collectionPatch("a", { pinned: true });
    assert(ctx.sourceActivity.source("a").sourceVersion.attributesRevision > first.sourceVersion.attributesRevision);
    const revision = ctx.sourceActivity.revision;
    rig.store.collectionPatch("a", { pinned: true }); assertEquals(ctx.sourceActivity.revision, revision);
    rig.store.collectionRemove("a"); assertEquals(ctx.inventory.isCurrent(oldToken), false); assert(!Object.hasOwn(ctx.hosts, "a"));
    rig.store.collectionAdd("a", "mock:1");
    assert(ctx.sourceActivity.source("a").incarnation !== first.incarnation);
    assertEquals(ctx.jobs.snapshot("a").epoch, epoch, "surviving alias shares the old address monitor, never the old collection lifetime");
    rig.store.entryHide("placeholder", "x.png"); assert(!Object.hasOwn(ctx.hosts, "placeholder"));
    const stream = ctx.sourceActivity.open(new Request("http://fixture/api/events")), reader = stream.body.getReader();
    const frame = await nextFrame(reader); validateSourceSnapshot(frame);
    assertEquals(frame.sources.a, ctx.sourceActivity.source("a"));
    await reader.cancel(); assertEquals(ctx.sourceActivity.deliveryStats(), []);
  } finally { ctx.sourceActivity.stop(); await ctx.jobs.stop(); await ctx.inventory.stop(); await rig.close(); }
});

Deno.test("stream bounds: slow readers coalesce a complete large map and do not stall mutations or a fast subscriber", async () => {
  const rig = await mkStateRig("stream-bounds");
  for (let i = 0; i < 150; i++) rig.store.collectionAdd(`source${i}`, "mock:1");
  for (const id of ["__proto__", "constructor", "toString"]) rig.store.collectionAdd(id, "mock:1");
  const hosts = rig.store.collectionMap();
  const ctx = sourceContext({ ...rig, hosts, inventory: makeTestInventory(hosts) });
  const slow = ctx.sourceActivity.open(new Request("http://fixture/api/events")).body.getReader();
  const fast = ctx.sourceActivity.open(new Request("http://fixture/api/events")).body.getReader();
  try {
    assertEquals((await slow.read()).value.byteLength, 16384);
    for (let i = 0; i < 100; i++) rig.store.collectionPatch("source0", { pinned: !!(i % 2) });
    const stats = ctx.sourceActivity.deliveryStats();
    assert(stats.every(s => s.activeFrames + s.pendingFrames <= 2 && s.queuedBytes <= 65536 + 16384));
    assertEquals(stats[0].activeFrames, 1); assertEquals(stats[0].pendingFrames, 1);
    const frame = await nextFrame(fast); validateSourceSnapshot(frame);
    assertEquals(Object.keys(frame.sources).length, 153);
    assert(Object.hasOwn(frame.sources, "__proto__")); assert(Object.hasOwn(frame.sources, "constructor"));
    assertEquals(frame.sources.source0.pinned, true);
    assertEquals(frame.sources.source0.sourceVersion.attributesRevision, rig.store.collectionRevision("source0"));
    assertEquals(ctx.jobs.monitors.size, 1);
    await slow.cancel(); await fast.cancel(); assertEquals(ctx.sourceActivity.deliveryStats(), []);
    ctx.sourceActivity.stop(); assertEquals(ctx.sourceActivity.open(new Request("http://fixture/api/events")).status, 503);
  } finally { await slow.cancel(); await fast.cancel(); ctx.sourceActivity.stop(); await ctx.jobs.stop(); await ctx.inventory.stop(); await rig.close(); }
});

Deno.test("injected source ownership: implicit Store placeholders never erase the explicit backing/lifecycle seam", async () => {
  const hosts = { fake: "mock:1" }, rig = await mkStateRig("injected-source", { hosts });
  const ctx = sourceContext(rig), token = ctx.inventory.capture("fake"), epoch = ctx.jobs.snapshot("fake").epoch;
  try {
    rig.store.entryHide("fake", "a.png");
    assertEquals(hosts.fake, "mock:1"); assert(ctx.inventory.isCurrent(token));
    assertEquals(ctx.jobs.snapshot("fake").epoch, epoch);
    assertEquals(ctx.sourceActivity.source("fake").address, "mock:1");
    validateSourceSnapshot(ctx.sourceActivity.snapshot());
  } finally { ctx.sourceActivity.stop(); await ctx.jobs.stop(); await rig.close(); }
});

Deno.test("protocol validates a whole frame atomically and retains exact own source keys", () => {
  const good = sourceFrame({ h: {}, folder: { kind: "folder", address: "folder:/fixture" } });
  assertEquals(validateSourceSnapshot(good), good);
  for (const mutate of [f => f.version++, f => delete f.sources.h.activity.progress,
    f => f.sources.h.sourceVersion.incarnation = "foreign", f => f.sources.folder.activity.supported = true,
    f => f.sources.h.activity.progress = { value: 1, max: 0, fraction: 1 }, f => f.sources.h.kind = "virtual",
    f => f.sources.h.activity.graph = {}, f => f.revision = -1]) {
    const bad = structuredClone(good); mutate(bad); assertThrows(() => validateSourceSnapshot(bad));
  }
});

Deno.test("native adapter ownership: invalid frames, stale callbacks, one retry, accepted-ready and capped backoff", () => {
  const instances = [], timers = new Map(), delays = [], snapshots = [], states = [];
  let nextTimer = 0;
  const dispose = subscribeSources({ onSnapshot: frame => snapshots.push(frame), onConnection: state => states.push(state) }, {
    random: () => .5, setTimer(cb, delay) { delays.push(delay); timers.set(++nextTimer, cb); return nextTimer; },
    clearTimer: id => timers.delete(id), createEventSource() {
      const source = { closed: 0, addEventListener(_name, callback) { this.callback = callback; }, close() { this.closed++; } };
      instances.push(source); return source;
    },
  });
  const emit = (source, frame) => source.callback({ data: JSON.stringify(frame), lastEventId: `${frame.epoch}:${frame.revision}` });
  assertEquals(states, ["connecting"]);
  const first = instances[0], frame = sourceFrame({ h: {} });
  emit(first, frame); assertEquals(states.at(-1), "ready");
  first.onerror(); first.onerror(); assertEquals(first.closed, 1); assertEquals(timers.size, 1);
  emit(first, sourceFrame({ h: { pinned: true } }, 5)); assertEquals(snapshots.length, 1);
  for (let i = 0; i < 7; i++) {
    const [id, retry] = timers.entries().next().value; timers.delete(id); retry();
    instances.at(-1).callback({ data: '{"version":99}', lastEventId: "broken" });
    assertEquals(timers.size, 1);
  }
  assertEquals(delays.at(-1), 30000); assert(delays.every(delay => delay <= 30000));
  dispose(); dispose(); assertEquals(timers.size, 0); assertEquals(instances.at(-1).closed, 1);
});

Deno.test("delivery-gap tickets: captured gaps only, target-null reads, foreign/forged/older/retired fences", () => {
  const owner = makeSourceFreshness(), foreign = makeSourceFreshness();
  owner.deliveryGap(); const captured = owner.capture(); owner.deliveryGap();
  owner.observe({ supported: true, state: "idle", epoch: "jobs", terminalRevision: 0, resyncRevision: 0 });
  assert(owner.accept(captured)); assert(owner.pending(), "captured unknown read cannot acknowledge a later Jobs tuple or newer gap");
  const older = owner.capture(); assertEquals(foreign.accept(older), false);
  assertEquals(owner.accept({ ...older, sequence: 1000 }), false);
  assert(owner.accept(owner.capture())); assertEquals(owner.pending(), false); assertEquals(owner.accept(older), false);
  owner.deliveryGap(); const retired = owner.capture(); owner.retire(); assertEquals(owner.accept(retired), false);
});

async function withStreamClient(run, delayed = false, configured = { h: {} }) {
  const oldApi = { ...api }, location = globalThis.location, history = globalThis.history;
  globalThis.location = { pathname: "/", search: "", hash: "#h" };
  globalThis.history = { state: null, replaceState() {}, pushState() {} };
  const initial = sourceFrame(configured), stream = injectedSourceStream(delayed ? null : initial);
  let reads = 0, cleanup;
  api.collections = async () => structuredClone(initial.sources);
  api.inventory = async () => { reads++; return clientInventory([{ name: "a.png", width: 100, height: 50, hash: "content", judgment: null }], { coverage: "recursive" }); };
  api.meta = async () => ({ changed: false, pending: 0 }); api.want = async () => ({ pending: 0 });
  api.nodes = async () => ({}); api.settings = async () => ({}); api.setSettings = async () => ({}); api.prefetch = async () => ({});
  const store = createRoot(dispose => { cleanup = dispose; return makeAppStore({ subscribeSources: stream.subscribe, storage: null }); });
  try { await store.actions.boot(); await run({ store, stream, initial, reads: () => reads }); }
  finally { store.dispose(); cleanup(); store.actions.status.clear("transient"); Object.assign(api, oldApi);
    if (location === undefined) delete globalThis.location; else globalThis.location = location;
    if (history === undefined) delete globalThis.history; else globalThis.history = history; }
}

Deno.test("push Store: delayed startup never blocks inventory, duplicates/progress do not relist, recovery repairs one gap", async () => {
  await withStreamClient(async ({ store, stream, initial, reads }) => {
    assertEquals(reads(), 1); assertEquals(store.state.images.length, 1);
    stream.snapshot(initial); await flush(); assertEquals(reads(), 2, "first-known target after read entry requires catch-up");
    stream.snapshot(initial); stream.snapshot(sourceFrame({ h: { activity: { state: "running", runningCount: 1, runningPromptId: "A", progress: { value: 2, max: 10, fraction: .2 } } } }, 1));
    await flush(); assertEquals(reads(), 2);
    for (let i = 0; i < 5; i++) stream.state("reconnecting");
    stream.snapshot(sourceFrame({ h: { activity: { state: "running", runningCount: 1, runningPromptId: "A", progress: { value: 2, max: 10, fraction: .2 } } } }, 1));
    await flush(); assertEquals(reads(), 3); assertEquals(stream.connections.length, 1);
  }, true);
});

Deno.test("push Store: newer events beat HTTP replies, queued toggles use latest confirmed value and progress flows during saves", async () => {
  await withStreamClient(async ({ store, stream, reads }) => {
    const replies = [], patches = [];
    api.patchCollection = (_id, patch) => { patches.push(patch); const held = deferred(); replies.push(held); return held.promise; };
    const first = store.handles.invoke("source.attributes", { id: "h", toggle: "pinned" });
    const second = store.handles.invoke("source.attributes", { id: "h", toggle: "pinned" });
    await flush(); assertEquals(patches, [{ pinned: true }]);
    const newer = sourceFrame({ h: { pinned: true, attributesRevision: 2,
      activity: { state: "running", runningCount: 1, runningPromptId: "A", progress: { value: 4, max: 10, fraction: .4 } } } }, 2);
    stream.snapshot(newer); assertEquals(store.state.sourceActivity.h.progress.fraction, .4); assertEquals(reads(), 1);
    assertEquals(store.state.hosts.h.pinned, false, "pending writer buffers authoritative flags without optimistic display");
    replies[0].resolve({ pinned: true, autoRefresh: true, sourceVersion: { ...newer.sources.h.sourceVersion, attributesRevision: 1 } });
    await first; await flush(); assertEquals(patches[1], { pinned: false });
    replies[1].resolve({ pinned: false, autoRefresh: true, sourceVersion: { ...newer.sources.h.sourceVersion, attributesRevision: 3 } });
    await second;
    stream.snapshot(sourceFrame({ h: { pinned: true, attributesRevision: 2 } }, 3));
    assertEquals(store.state.hosts.h.pinned, false, "older event cannot undo confirmed HTTP version3");
    assertEquals(store.state.sourceSaving.h, undefined);
  });
});

Deno.test("push Store: full-map replacement fences old reads/flags, late discovery cannot resurrect, page lifecycle has one owner", async () => {
  await withStreamClient(async ({ store, stream, initial }) => {
    const discovery = deferred(); api.collections = () => discovery.promise;
    const pending = store.actions.hosts.refresh(), before = store.state.images[0];
    const target = new EventTarget(); store.actions.lifecycle.registerPage(target);
    target.dispatchEvent(new Event("pagehide")); assertEquals(stream.connections[0].cleanups, 1);
    assertEquals(store.state.images[0], before); target.dispatchEvent(new Event("pageshow"));
    assertEquals(stream.connections.length, 2);
    const replacement = sourceFrame({ h: { incarnation: "replacement", pinned: true } }, 5);
    stream.snapshot(replacement); await flush();
    discovery.resolve(initial.sources);
    await pending;
    assertEquals(store.state.hosts.h.incarnation, "replacement"); assertEquals(store.state.hosts.h.pinned, true);
    stream.connections[0].callbacks.onSnapshot(sourceFrame({ h: { pinned: false } }, 99));
    assertEquals(store.state.hosts.h.incarnation, "replacement");
    store.dispose(); store.dispose(); target.dispatchEvent(new Event("pageshow"));
    assertEquals(stream.connections.length, 2); assertEquals(stream.connections[1].cleanups, 1);
  });
});

Deno.test("exact source IDs: reserved and ordinary names retain reactive flags/activity/saving, selection and reincarnation", async () => {
  const configured = Object.fromEntries(["h", "__proto__", "constructor", "prototype", "toString"].map(id => [id, {}]));
  await withStreamClient(async ({ store, stream }) => {
    assertEquals(Object.keys(store.state.hosts).sort(), Object.keys(configured).sort());
    for (const id of Object.keys(configured)) {
      assert(Object.hasOwn(store.state.hosts, id));
      assertEquals(store.state.sourceActivity[id].state, "idle");
      await store.actions.hosts.select(id); assertEquals(store.state.host(), id);
      const held = deferred(); api.patchCollection = () => held.promise;
      const write = store.actions.hosts.patch(id, { pinned: true }); await flush();
      assertEquals(store.state.sourceSaving[id], true);
      const version = { ...store.state.hosts[id].sourceVersion, attributesRevision: 1 };
      held.resolve({ pinned: true, autoRefresh: true, sourceVersion: version }); await write;
      assertEquals(store.state.hosts[id].pinned, true); assertEquals(store.state.sourceSaving[id], undefined);
      configured[id] = { pinned: true, attributesRevision: 1, activity: { state: "running", runningCount: 1, runningPromptId: "A" } };
      stream.snapshot(sourceFrame(configured, version.attributesRevision + Object.keys(configured).indexOf(id) + 1));
      assertEquals(store.state.sourceActivity[id].runningPromptId, "A");
    }
    const old = store.state.hosts.constructor.incarnation;
    configured.constructor.incarnation = "replacement"; configured.constructor.attributesRevision = 0;
    stream.snapshot(sourceFrame(configured, 20)); await flush();
    assert(store.state.hosts.constructor.incarnation !== old);
    delete configured.__proto__; stream.snapshot(sourceFrame(configured, 21));
    assert(!Object.hasOwn(store.state.hosts, "__proto__"));
  }, false, configured);
});

Deno.test("source engine shutdown: SIGTERM retires a deliberately open subscriber before HTTP drain", async () => {
  const directory = await Deno.makeTempDir({ prefix: "kz-source-stop-" });
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 }), port = listener.addr.port; listener.close();
  const child = new Deno.Command(Deno.execPath(), { args: ["run", "--frozen", "--allow-all", "src/main.mjs"],
    env: { KOZMOZOO_PORT: String(port), KOZMOZOO_HOSTS: "", KOZMOZOO_STATE: directory,
      KOZMOZOO_CACHE: `${directory}/cache`, KOZMOZOO_FEEDBACK: "" }, stdout: "piped", stderr: "piped" }).spawn();
  const output = new Response(child.stdout).text(), errors = new Response(child.stderr).text();
  let reader, ended = false, timer;
  try {
    for (let i = 0; i < 100; i++) {
      try { const response = await fetch(`http://127.0.0.1:${port}/api/events`); reader = response.body.getReader(); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert(reader, "actual source engine admitted the subscriber");
    const frame = await nextFrame(reader); validateSourceSnapshot(frame);
    const started = performance.now(); child.kill("SIGTERM");
    const status = await Promise.race([child.status, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("SIGTERM exceeded30s with an open subscriber")), 30000);
    })]);
    ended = true; clearTimeout(timer);
    assertEquals(status.code, 0); assert(status.success);
    assert((await reader.read()).done, "stream ends without waiting for a browser to close it");
    const logs = { stdout: await output, stderr: await errors, status, elapsedMs: performance.now() - started };
    await Deno.writeTextFile(`${directory}/shutdown.json`, JSON.stringify(logs, null, 2));
    console.log(JSON.stringify({ sourceShutdown: logs.elapsedMs, exit: status.code, evidence: directory }));
  } finally {
    clearTimeout(timer); await reader?.cancel();
    if (!ended) { try { child.kill("SIGTERM"); } catch { /* already exited */ } await child.status; }
  }
});

Deno.test("delivery failure isolation: throwing subscribers cannot roll committed flags back or mark Comfy disconnected", async () => {
  const rig = await mkStateRig("delivery-errors"), oldError = console.error, reported = [];
  rig.store.collectionAdd("h", "mock:1"); const hosts = rig.store.collectionMap();
  const jobs = new Jobs({ hosts, client: () => ({ queue: async () => ({ running: [], pending: [] }), history: async () => [] }) });
  const ctx = sourceContext({ ...rig, hosts, jobs, inventory: makeTestInventory(hosts) });
  const storeDispose = rig.store.subscribeCollections(() => { throw Error("subscriber failed"); });
  const jobsDispose = jobs.subscribe(() => { throw Error("subscriber failed"); });
  console.error = (...args) => reported.push(args);
  try {
    rig.store.collectionPatch("h", { pinned: true }); await jobs.tick();
    assertEquals(rig.store.collectionGet("h").pinned, 1); assert(ctx.sourceActivity.source("h").pinned);
    assertEquals(jobs.snapshot("h").state, "idle"); assertEquals(jobs.snapshot("h").error, null);
    assert(reported.some(args => args[0].includes("collection delivery")));
    assert(reported.some(args => args[0].includes("activity delivery")));
  } finally { console.error = oldError; storeDispose(); jobsDispose(); ctx.sourceActivity.stop(); await jobs.stop(); await ctx.inventory.stop(); await rig.close(); }
});

Deno.test("push Store atomic validation: malformed later record cannot partially publish earlier flags or membership", async () => {
  await withStreamClient(async ({ store, stream }) => {
    const before = store.state.hosts.h, image = store.state.images[0];
    const invalid = sourceFrame({ h: { pinned: true, attributesRevision: 1 }, bad: {} }, 1);
    delete invalid.sources.bad.activity.progress;
    assertThrows(() => stream.snapshot(invalid));
    assertEquals(store.state.hosts.h, before); assertEquals(store.state.hosts.h.pinned, false);
    assert(!Object.hasOwn(store.state.hosts, "bad")); assertEquals(store.state.images[0], image);
  });
});

Deno.test("push Store failed writer: newest buffered committed flags survive failure and drain with saving/error state", async () => {
  await withStreamClient(async ({ store, stream }) => {
    const pending = deferred(); api.patchCollection = () => pending.promise;
    const write = store.actions.hosts.patch("h", { pinned: true }); await flush();
    stream.snapshot(sourceFrame({ h: { pinned: true, attributesRevision: 2 } }, 2));
    assertEquals(store.state.hosts.h.pinned, false); assertEquals(store.state.sourceSaving.h, true);
    pending.reject(Error("write reply lost")); assertEquals((await write).ok, false);
    assertEquals(store.state.hosts.h.pinned, true); assertEquals(store.state.sourceSaving.h, undefined);
    assert(store.state.chips.some(chip => chip.kind === "error" && chip.msg.includes("write reply lost")));
  });
});

Deno.test("push Store gap retention: disabled repair waits for confirmed enablement and reads acknowledge only captured episodes", async () => {
  await withStreamClient(async ({ store, stream, reads }) => {
    const disabled = sourceFrame({ h: { autoRefresh: false, attributesRevision: 1 } }, 1);
    stream.snapshot(disabled); stream.state("reconnecting"); stream.snapshot(disabled); await flush();
    assertEquals(reads(), 1);
    const owned = deferred(), listing = api.inventory; let repairs = 0;
    api.inventory = async () => { repairs++; if (repairs === 1) return owned.promise; return listing(); };
    stream.snapshot(sourceFrame({ h: { autoRefresh: true, attributesRevision: 2 } }, 2)); await flush();
    assertEquals(repairs, 1);
    stream.state("reconnecting"); stream.state("reconnecting");
    stream.snapshot(sourceFrame({ h: { autoRefresh: true, attributesRevision: 2 } }, 2));
    owned.resolve(clientInventory([{ name: "a.png", width: 100, height: 50, hash: "content", judgment: null }], { coverage: "recursive" }));
    await flush(); assertEquals(repairs, 2, "older repair cannot consume a newer genuine loss episode");
    stream.snapshot(sourceFrame({ h: { autoRefresh: true, attributesRevision: 2 } }, 2)); await flush(); assertEquals(repairs, 2);
  });
});

Deno.test("membership causality: committed removal/re-add acknowledgements fence older complete stream maps", async () => {
  await withStreamClient(async ({ store, stream }) => {
    api.removeCollection = async () => ({ removed: "h", sourceCursor: { epoch: "stream", revision: 2 },
      sourceVersion: { epoch: "stream", incarnation: "h-lifetime", attributesRevision: 1 } });
    await store.actions.hosts.remove("h");
    assert(!Object.hasOwn(store.state.hosts, "h"));
    stream.snapshot(sourceFrame({ h: {}, other: {} }, 1));
    assert(!Object.hasOwn(store.state.hosts, "h"), "an older active frame cannot resurrect the acknowledged removal");
    stream.snapshot(sourceFrame({ other: {} }, 2));
    const replacement = sourceFrame({ h: { incarnation: "new-h" }, other: {} }, 4).sources.h;
    api.addCollection = async () => ({ name: "h", ...replacement, online: true, sourceCursor: { epoch: "stream", revision: 4 } });
    await store.actions.hosts.add("h", "mock:1");
    assertEquals(store.state.hosts.h.incarnation, "new-h");
    stream.snapshot(sourceFrame({ h: {}, other: {} }, 3));
    assertEquals(store.state.hosts.h.incarnation, "new-h", "known replacement ownership cannot revert to an older incarnation");
    stream.snapshot(sourceFrame({ h: { incarnation: "new-h" }, other: {} }, 4));
    assertEquals(store.state.host(), "other", "inactive re-add never steals selection");
  }, false, { h: {}, other: {} });
});

Deno.test("source shutdown admission: cached compatibility projection survives lifecycle stop and source writes refuse", async () => {
  const rig = await mkStateRig("source-admission"); rig.store.collectionAdd("a", "mock:1"); rig.store.collectionAdd("b", "mock:2");
  const hosts = rig.store.collectionMap(), ctx = sourceContext({ ...rig, hosts, inventory: makeTestInventory(hosts) });
  const { makeRouter } = await import("../src/routes.mjs"), router = makeRouter(ctx), before = ctx.sourceActivity.snapshot();
  try {
    ctx.sourceActivity.stop(); await ctx.jobs.stop(); await ctx.inventory.stop();
    assertEquals(ctx.sourceActivity.snapshot(), before);
    assertEquals(ctx.sourceActivity.source("a"), before.sources.a);
    assertEquals((await router.handle(new Request("http://fixture/api/events"))).status, 503);
    assertEquals((await router.handle(new Request("http://fixture/api/collections/a", { method: "PATCH", body: '{"pinned":true}' }))).status, 503);
    assertEquals((await router.handle(new Request("http://fixture/api/collections/a", { method: "DELETE" }))).status, 503);
    assertEquals(rig.store.collectionGet("a").pinned, 0); assert(rig.store.collectionGet("a"));
  } finally { ctx.sourceActivity.stop(); await rig.close(); }
});
