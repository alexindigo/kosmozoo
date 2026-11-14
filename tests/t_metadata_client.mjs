import { assert, assertEquals } from "jsr:@std/assert";
import { createRoot, createMemo, createEffect, batch } from "solid-js";
import { createStore } from "solid-js/store";
import { makeAcquisition } from "../client-solid/store/acquisition.js";
import { makeMetadata } from "../client-solid/store/metadata.js";

const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(yes => resolve = yes); return { promise, resolve }; };
function fixture(overrides = {}, policyOptions = {}) {
  const owner = { id: "source", session: 1 }, requests = [], reads = [], registries = [];
  const acquisition = makeAcquisition({ scheduleIdle: callback => {
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) callback({ timeRemaining: () => 8 }); });
    return () => { cancelled = true; };
  }, ...policyOptions });
  acquisition.setContext(owner);
  const channel = makeMetadata({ acquisition, owns: value => value === owner, batch,
    want: async (_id, names, options) => { requests.push({ names, options }); return { pending: 0 }; },
    meta: async (_id, since) => { reads.push(since); return { changed: false, pending: 0 }; },
    nodes: async () => { registries.push("read"); return {}; }, status: async () => ({}),
    setPending() {}, setNodes() {}, setStatus() {}, apply() {}, ...overrides });
  channel.setContext(owner);
  return { owner, channel, acquisition, requests, reads, registries,
    dispose() { channel.dispose(); acquisition.dispose(); } };
}

Deno.test("metadata wants: a stable foreground is acknowledged once across repeated landings; background is dimensions-only", async () => {
  const f = fixture();
  const images = Array.from({ length: 5000 }, (_, i) => ({ id: `source:${i}`, filename: `${i}.png`, hash: null }));
  try {
    f.acquisition.setWindow({ ids: images.map(image => image.id), currentId: images[0].id });
    for (let landing = 0; landing < 50; landing++) f.channel.request(images.slice(0, 20));
    await flush();
    assertEquals(f.requests.length, 1);
    assertEquals(f.requests[0].names.length, 20, "initial inventory promotes only the window");
    for (let landing = 0; landing < 50; landing++) f.channel.request(images.slice(0, 20));
    await flush(); assertEquals(f.requests.length, 1);
    f.channel.request(images.slice(0, 20), { renew: true }); await flush();
    assertEquals(f.requests.length, 2, "a new accepted inventory may renew an acknowledged obligation");
    f.channel.request(images.slice(20, 220), { interest: "dimensions", priority: "background" });
    await flush();
    assertEquals(f.requests.length, 3);
    assertEquals(f.requests[2].options, { interest: "dimensions", priority: "background" });
  } finally { f.dispose(); }
});

Deno.test("metadata wants: one flight retains an upgraded demand and never acknowledges a replacement's content", async () => {
  const held = deferred(), calls = [];
  const f = fixture({ want: async (_id, names, options) => {
    calls.push({ names, options }); if (calls.length === 1) return held.promise; return { pending: 0 };
  } });
  try {
    const image = { id: "source:a", filename: "a.png", hash: "old" };
    f.channel.request([image], { interest: "dimensions", priority: "background" }); await flush();
    f.channel.request([{ ...image, hash: "replacement" }]); await flush();
    assertEquals(calls.length, 1, "acknowledgement, not a landing, opens the next POST");
    held.resolve({ pending: 0 }); await flush();
    assertEquals(calls.length, 2);
    assertEquals(calls[1].options, { interest: "full", priority: "foreground" });
  } finally { held.resolve({ pending: 0 }); f.dispose(); }
});

Deno.test("metadata wants: failure retains its obligation behind backoff", async () => {
  let calls = 0;
  const f = fixture({ want: async () => { if (++calls === 1) throw Error("offline"); return { pending: 0 }; } });
  try {
    const images = [{ id: "source:a", filename: "a.png" }];
    f.channel.request(images); await flush();
    for (let landing = 0; landing < 10; landing++) f.channel.request(images);
    await flush(); assertEquals(calls, 1);
    await new Promise(resolve => setTimeout(resolve, 1100));
    assertEquals(calls, 2);
    f.channel.request(images); await flush(); assertEquals(calls, 2);
  } finally { f.dispose(); }
});

Deno.test("metadata wants: a queued background POST promotes before idle admission and captures its exact acknowledged intent", async () => {
  const idle = new Map(); let sequence = 0;
  const f = fixture({}, { scheduleIdle: callback => { const key = ++sequence; idle.set(key, callback); return () => idle.delete(key); } });
  const image = { id: "source:a", filename: "a.png" };
  try {
    f.channel.request([image], { interest: "dimensions", priority: "background" }); await flush();
    assertEquals(f.requests, []);
    f.channel.request([image]); await flush();
    assertEquals(f.requests, [{ names: ["a.png"], options: { interest: "full", priority: "foreground" } }]);
    f.channel.request([image]); await flush();
    assertEquals(f.requests.length, 1);
  } finally { f.dispose(); }
});

Deno.test("metadata wants: queued old-window demand consumes the current projection and browser priority", async () => {
  const idle = new Map(); let sequence = 0, f;
  f = fixture({ priorityFor: item => f.acquisition.priority(item.id) }, {
    scheduleIdle: callback => { const key = ++sequence; idle.set(key, callback); return () => idle.delete(key); },
  });
  try {
    f.acquisition.setWindow({ ids: ["source:a", "source:b"], currentId: "source:a", limit: 1 });
    f.acquisition.setGesture(true);
    f.channel.request([{ id: "source:a", filename: "a.png" }]); await flush();
    f.acquisition.setWindow({ ids: ["source:a", "source:b"], currentId: "source:b", limit: 1 });
    f.acquisition.setGesture(false); await flush();
    assertEquals(f.requests.length, 0, "the retired foreground grant cannot start immediately");
    const [key, callback] = idle.entries().next().value;
    idle.delete(key); callback({ timeRemaining: () => 8 }); await flush();
    assertEquals(f.requests[0].options.priority, "background");
  } finally { f.dispose(); }
});

Deno.test("metadata wants: scheduler head queries do not traverse acknowledged library demand", async () => {
  let lookups = 0, f;
  f = fixture({ priorityFor: item => { lookups++; return f.acquisition.priority(item.id); } }, {
    scheduleIdle: () => () => {},
  });
  const images = Array.from({ length: 5000 }, (_, i) => ({ id: `source:${i}`, filename: `${i}.png` }));
  try {
    // Acknowledge a large retained library, leaving one queued obligation.
    f.acquisition.setWindow({ ids: images.map(image => image.id), currentId: images[0].id, limit: 5000 });
    f.channel.request(images);
    for (let i = 0; i < 300; i++) await flush();
    assertEquals(f.requests.flatMap(request => request.names).length, 5000);
    f.acquisition.setWindow({ ids: images.map(image => image.id), currentId: images[0].id, limit: 1 });
    f.acquisition.setGesture(true);
    f.channel.request([{ id: "source:extra", filename: "extra.png" }]); await flush();
    lookups = 0;
    for (let i = 0; i < 50; i++) f.acquisition.reconcile();
    assert(lookups < 200, `head checks must be independent of retained library size; got ${lookups} lookups`);
    // The queued obligation still promotes without scanning the library.
    f.acquisition.setWindow({ ids: ["source:extra"], currentId: "source:extra", limit: 1 });
    f.acquisition.setGesture(false); await flush();
    assertEquals(f.requests.at(-1).names, ["extra.png"]);
  } finally { f.dispose(); }
});

Deno.test("metadata acceptance: bounded batches publish width and height atomically with one readiness reconciliation each", async () => {
  let rootDispose, publications = 0, reconciliations = 0, active = false;
  const [state, setState] = createStore({ images: Array.from({ length: 450 }, () => ({ width: null, height: null })) });
  createRoot(dispose => {
    rootDispose = dispose;
    const ready = createMemo(() => state.images.filter(image => image.width && image.height).length);
    createEffect(() => {
      const count = ready();
      if (!active) return;
      reconciliations++;
      assert(state.images.every(image => !!image.width === !!image.height), "no half-published dimensions");
      assert(count > 0);
    });
  });
  const f = fixture({ batch: callback => { publications++; batch(callback); },
    apply(name, _meta, dims) { setState("images", Number(name), { width: dims.width, height: dims.height }); return false; } });
  try {
    active = true;
    const reply = { changed: true, v: 4, dims: Object.fromEntries(state.images.map((_, i) => [String(i), { width: 640, height: 360 }])) };
    await f.channel.accept(reply, f.owner);
    assert(publications >= 3, "450 entries cannot fit a 200-entry maximum batch");
    assertEquals(reconciliations, publications);
    assertEquals(state.images.filter(image => image.width === 640 && image.height === 360).length, 450);
    assertEquals(f.registries.length, 0, "dimension-only changes never refetch the node registry");
    await f.channel.poll(); assertEquals(f.reads, [4], "the cursor advances after all publications");
  } finally { f.dispose(); rootDispose(); }
});

Deno.test("metadata acceptance: source retirement stops a queued delta and graph changes refresh nodes once", async () => {
  const applied = [], f = fixture({ apply: (name, meta) => { applied.push(name); return !!meta; } });
  try {
    await f.channel.accept({ changed: true, v: 1, items: { a: { nodes: [] }, b: { nodes: [] } } }, f.owner);
    assertEquals(f.registries, ["read"]);
    const old = f.channel.accept({ changed: true, v: 2, dims: { stale: { width: 1, height: 1 } } }, f.owner);
    f.channel.setContext({ id: "source", session: 2 });
    f.acquisition.setContext({ id: "source", session: 2 });
    await old;
    assertEquals(applied, ["a", "b"]);
  } finally { f.dispose(); }
});

Deno.test("metadata wants: an acknowledgement publishes known state that a delta could not apply before inventory listed the entry", async () => {
  const applied = [], known = new Map();
  const f = fixture({
    meta: async () => ({ changed: true, v: 9, items: {}, dims: { "late.png": { width: 4, height: 2 } }, pending: 0 }),
    want: async (_id, names) => ({ pending: 0, items: {},
      dims: Object.fromEntries(names.filter(name => name === "late.png").map(name => [name, { width: 4, height: 2 }])) }),
    capture: names => new Map((names ?? [...known.keys()]).filter(name => known.has(name)).map(name => [name, known.get(name)])),
    apply: (name, _meta, dims, _owner, snapshot) => { if (snapshot.has(name)) applied.push([name, dims]); return false; },
  });
  try {
    await f.channel.poll(); await flush();
    assertEquals(applied, [], "inventory had not listed the entry: the cursor still moved past its change");
    known.set("late.png", "hash");
    f.channel.request([{ id: "source:late.png", filename: "late.png", hash: "hash" }], { interest: "dimensions", priority: "background" });
    await flush(); await flush();
    assertEquals(applied, [["late.png", { width: 4, height: 2 }]], "wanting the listed identity delivers its current dimensions");
  } finally { f.dispose(); }
});

Deno.test("metadata lanes: work for a foreground identity never queues behind pending foreground resources as background", async () => {
  const applied = [];
  const f = fixture({
    want: async () => ({ pending: 1, items: {}, dims: {} }),
    meta: async () => ({ changed: true, v: 2, items: { "cur.png": { seed: 1 }, "far.png": { seed: 2 } }, dims: {}, pending: 0 }),
    capture: () => new Map([["cur.png", "h1"], ["far.png", "h2"]]),
    apply: (name) => { applied.push(name); return false; },
  });
  try {
    f.acquisition.setWindow({ ids: ["source:cur"], currentId: "source:cur" });
    // A long-running foreground resource keeps background admission paused.
    f.acquisition.submit({ key: "held-foreground", id: "source:cur", run: () => new Promise(() => {}) });
    f.channel.request([{ id: "source:cur", filename: "cur.png", hash: "h1" }]);
    f.channel.request([{ id: "source:far", filename: "far.png", hash: "h2" }], { priority: "background" });
    await flush();
    await new Promise(resolve => setTimeout(resolve, 1150)); await flush(); await flush();
    assertEquals(applied[0], "cur.png", "the current entry's acknowledged demand is polled and published in the foreground lane, first");
  } finally { f.dispose(); }
});

for (const [count, position] of [[25, 0], [25, 12], [25, 24], [1, 0]]) {
  Deno.test(`metadata control: want/poll/registry reach fields at position ${position} of ${count} while six native resources remain held`, async () => {
    const images = Array.from({ length: count }, (_, i) => ({ id: `source:${i}`, filename: `${i}.png` }));
    const applied = [], calls = [], native = Array.from({ length: 6 }, deferred);
    let f;
    f = fixture({
      priorityFor: item => f.acquisition.priority(item.id),
      want: async (_id, names, options) => { calls.push(["want", options.priority]); return { pending: 1, items: {}, dims: {} }; },
      meta: async (_id, _version, options) => { calls.push(["poll", options.priority]); return { pending: 0, changed: true, v: 1,
        items: { [`${position}.png`]: { nodes: [{ type: "NewType", inputs: { token: "visible-value" } }] } } }; },
      nodes: async options => { calls.push(["nodes", options.priority]); return { NewType: { inputs: { token: "string" } } }; },
      apply: (_name, meta) => { if (meta) applied.push(meta); return !!meta; },
    }, { scheduleIdle: () => () => {} });
    try {
      f.acquisition.setWindow({ ids: images.map(image => image.id), currentId: images[position].id, limit: 1 });
      native.forEach((hold, i) => f.acquisition.submit({ key: `native-${i}`, priority: "foreground", run: () => hold.promise }));
      f.channel.request([images[position]]); await flush();
      assertEquals(calls, [["want", "foreground"]]);
      f.channel.poll(); await flush(); await flush();
      assertEquals(calls, [["want", "foreground"], ["poll", "foreground"], ["nodes", "foreground"]]);
      assertEquals(applied[0]?.nodes[0].inputs.token, "visible-value");
    } finally { f.dispose(); native.forEach(hold => hold.resolve()); await flush(); }
  });
}

// A Store-shaped entry table for the shown-record path: the real application
// fence (snapshot for deltas, content identity for records).
function shownFixture(overrides = {}) {
  const store = new Map(), records = [], polls = [];
  let held = null;
  const f = fixture({
    want: async () => ({ pending: 1, items: {}, dims: {} }),
    meta: (_id, since) => { polls.push(since); if (polls.length === 1) return new Promise(resolve => { held = resolve; });
      return Promise.resolve({ v: 2, changed: since !== 2, items: {}, dims: {}, pending: 1 }); },
    entry: async (_id, name) => { records.push(name); return overrides.record?.(name) ?? { name, hash: "hx", extracted: true, meta: { nodes: [{ type: "Shown", inputs: { token: name } }] } }; },
    capture: names => new Map([...store.values()].filter(i => !names || names.includes(i.filename)).map(i => [i.filename, i.hash])),
    apply(name, meta, _dims, _owner, snapshot) {
      const image = store.get(name);
      if (!image || !snapshot.has(name) || snapshot.get(name) !== image.hash) return false;
      if (meta && !image.meta) { image.meta = meta; image.extracted = true; return true; }
      return false;
    },
    adopt(name, record, _owner, identity) {
      const image = store.get(name);
      if (!image || (image.hash ?? "") !== identity || image.hash && record.hash && record.hash !== image.hash) return false;
      if (record.meta && !image.meta) { image.meta = record.meta; image.extracted = true; return "graph"; }
      if (record.extracted) image.extracted = true;
      return "applied";
    },
    retryDelay: () => 0, ...overrides.options,
  });
  const list = image => { store.set(image.filename, image); return image; };
  return { ...f, store, records, polls, list, release: reply => held?.(reply) };
}

Deno.test("metadata shown record: optional timing is read with an already populated graph and fenced on navigation", async () => {
  const held = deferred(), adopted = [];
  const f = fixture({
    needsEntry: image => !image.meta || image.generationTimeMs === undefined,
    entry: async (_source, name) => name === "old.png" ? held.promise : { name, meta: { nodes: [] }, extracted: true, generationTimeMs: null },
    adopt: (name, record) => { adopted.push([name, record.generationTimeMs]); return "applied"; },
  });
  try {
    f.channel.show([{ id: "source:old.png", filename: "old.png", hash: "old", meta: { nodes: [] } }]);
    await flush();
    f.channel.show([{ id: "source:new.png", filename: "new.png", hash: "new", meta: { nodes: [] } }]);
    await flush();
    held.resolve({ name: "old.png", meta: { nodes: [] }, extracted: true, generationTimeMs: 140138 });
    await flush();
    assertEquals(adopted, [["new.png", null]], "late timing cannot decorate the newly selected image");
    f.channel.show([{ id: "source:new.png", filename: "new.png", hash: "new", meta: { nodes: [] }, generationTimeMs: null }]);
    await flush(); assertEquals(adopted.length, 1, "an authoritative unavailable result is not a polling loop");
  } finally { f.dispose(); held.resolve({}); }
});

Deno.test("metadata shown record: completion evidence refreshes timing without a new polling loop", async () => {
  let reads = 0;
  const image = { id: "source:image.png", filename: "image.png", hash: "hash", meta: true, recordRevision: "first" };
  const f = fixture({
    needsEntry: value => value.recordRevision !== value.generationTimeRevision,
    entry: async () => ({ meta: { nodes: [] }, extracted: true, generationTimeMs: ++reads === 1 ? null : 140138 }),
    adopt: (_name, record, _owner, _hash, revision) => {
      image.generationTimeMs = record.generationTimeMs; image.generationTimeRevision = revision; return "applied";
    },
  });
  try {
    f.channel.show([image]); await flush(); assertEquals(image.generationTimeMs, null);
    f.channel.show([image]); await flush(); assertEquals(reads, 1);
    image.recordRevision = "completion";
    f.channel.show([image]); await flush(); assertEquals(image.generationTimeMs, 140138);
    f.channel.show([image]); await flush(); assertEquals(reads, 2);
  } finally { f.dispose(); }
});

Deno.test("metadata shown record: a delta consumed by a pre-listing snapshot cannot strand the shown entry", async () => {
  const f = shownFixture();
  try {
    f.list({ id: "source:a.png", filename: "a.png", hash: "ha", meta: { a: 1 }, extracted: true });
    f.acquisition.setWindow({ ids: ["source:a.png"], currentId: "source:a.png" });
    const poll = f.channel.poll(); await flush();            // snapshot: x.png unlisted
    const x = f.list({ id: "source:x.png", filename: "x.png", hash: null, meta: null, extracted: false });
    f.acquisition.setWindow({ ids: ["source:x.png", "source:a.png"], currentId: "source:x.png" });
    f.channel.request([x], { renew: true });                // acknowledged empty: not ingested yet
    f.channel.show?.([x]);                                   // the details pane shows it
    f.release({ v: 2, changed: true, items: { "x.png": { nodes: [] } }, dims: {}, pending: 1 });
    await poll; await flush();
    await f.channel.poll(); await flush();
    assertEquals(f.polls, [0, 2], "the stream's cursor moved past x.png");
    assert(f.store.get("x.png").meta?.nodes?.[0]?.inputs?.token === "x.png", "the shown entry has its own record");
    assertEquals(f.registries, ["read"], "its new graph refreshes the field registry");
  } finally { f.dispose(); }
});

Deno.test("metadata shown record: a listed negative cannot suppress the entry's own read after its delta was consumed", async () => {
  const f = shownFixture();
  try {
    const name = "video/long # name%2F_".padEnd(180, "x") + ".mp4";
    const poll = f.channel.poll(); await flush(); // the target is not listed yet
    f.release({ v: 2, changed: true, items: { [name]: { nodes: [] } }, pending: 0 });
    await poll;
    const x = f.list({ id: `source:${name}`, filename: name, hash: "hx", meta: null, extracted: true });
    f.channel.show([x]); await flush();
    assertEquals(f.records, [name], "collection-level absence is not the shown record's delivery");
    assertEquals(x.meta?.nodes[0].inputs.token, name);
    f.channel.show([x]); await flush();
    assertEquals(f.records.length, 1, "a populated record needs no repeated read");
  } finally { f.dispose(); }
});

Deno.test("metadata shown record: authoritative absence settles once per shown content identity", async () => {
  const f = shownFixture({ record: name => ({ name, hash: "hx", extracted: true, meta: null }) });
  try {
    const x = f.list({ id: "source:bare.webm", filename: "bare.webm", hash: "hx", meta: null, extracted: true });
    f.channel.show([x]); await flush();
    assertEquals(f.records, [x.filename], "verify the negative through the entry record");
    for (let i = 0; i < 3; i++) { f.channel.show([x]); await flush(); }
    assertEquals(f.records.length, 1, "a verified negative does not become a poll loop");
    f.channel.show([]); f.channel.show([x]); await flush();
    assertEquals(f.records.length, 2, "showing it again owns a fresh record read");
    f.channel.show([{ ...x, hash: "new" }]); await flush();
    assertEquals(f.records.length, 3, "changed content retires the old negative");
  } finally { f.dispose(); }
});

Deno.test("metadata shown record: unextracted replies retry while shown; hiding or replacing the identity retires the flight", async () => {
  let ready = false;
  const f = shownFixture({ record: name => ready ? { name, hash: "h1", extracted: true, meta: null } : { name, hash: null, extracted: false, meta: null } });
  try {
    const x = f.list({ id: "source:x.png", filename: "x.png", hash: null, meta: null, extracted: false });
    f.channel.show([x]); await flush();
    await new Promise(resolve => setTimeout(resolve, 5)); await flush();
    assert(f.records.length >= 2, "an unavailable record is read again");
    ready = true;
    await new Promise(resolve => setTimeout(resolve, 5)); await flush();
    assertEquals(f.store.get("x.png").extracted, true, "an entry without parameters leaves loading too");
    assertEquals(f.store.get("x.png").meta, null);
    const reads = f.records.length;
    f.channel.show([{ ...x, extracted: true }]); await flush();
    await new Promise(resolve => setTimeout(resolve, 5)); await flush();
    assertEquals(f.records.length, reads, "a satisfied identity issues no further read");
    // A replaced content identity: the old flight cannot apply to the new one.
    ready = false;
    const y = f.list({ id: "source:y.png", filename: "y.png", hash: "old", meta: null, extracted: false });
    f.channel.show([y]); await flush();
    y.hash = "new"; f.channel.show([y]); f.channel.show([]);
    await new Promise(resolve => setTimeout(resolve, 5)); await flush();
    const settled = f.records.length;
    await new Promise(resolve => setTimeout(resolve, 5)); await flush();
    assertEquals(f.records.length, settled, "no identity is shown: no retries remain");
  } finally { f.dispose(); }
});

Deno.test("metadata shown record: a refused record (different content) settles until the listing moves on", async () => {
  const f = shownFixture({ record: name => ({ name, hash: "other", extracted: true, meta: { nodes: [] } }) });
  try {
    const x = f.list({ id: "source:x.png", filename: "x.png", hash: "listed", meta: null, extracted: false });
    f.channel.show([x]); await flush();
    for (let i = 0; i < 3; i++) { f.channel.show([x]); await flush(); }
    assertEquals(f.records, ["x.png"]);
    assertEquals(f.store.get("x.png").meta, null, "a record of other content never applies");
    x.hash = "other"; f.channel.show([x]); await flush();
    assertEquals(f.records, ["x.png", "x.png"]);
    assertEquals(f.store.get("x.png").meta, { nodes: [] });
  } finally { f.dispose(); }
});

Deno.test("metadata shown record: independent of a held collection snapshot and its publication", async () => {
  const f = shownFixture();
  try {
    const x = f.list({ id: "source:x.png", filename: "x.png", hash: null, meta: null, extracted: false });
    f.acquisition.setWindow({ ids: ["source:x.png"], currentId: "source:x.png" });
    f.channel.poll(); await flush();                          // the full snapshot is still in flight
    f.channel.show([x]); await flush();
    assertEquals(f.records, ["x.png"]);
    assert(f.store.get("x.png").meta, "the shown record applied while the snapshot was held");
  } finally { f.release({ v: 2, changed: false, pending: 0 }); f.dispose(); }
});

Deno.test("metadata cursor: a session continues the delta stream from its first listing's version, never a full snapshot", async () => {
  const f = fixture();
  try {
    f.channel.resume(41, f.owner);
    await f.channel.poll();
    f.channel.resume(7, f.owner);
    f.channel.resume(99, { id: "other" });
    await f.channel.poll();
    assertEquals(f.reads, [41, 41], "only the session's first listing sets the cursor; other owners cannot");
    const g = fixture();
    try {
      for (const invalid of [undefined, null, 0, -1, 1.5, "41"]) g.channel.resume(invalid, g.owner);
      await g.channel.poll();
      assertEquals(g.reads, [0], "a listing without a version keeps the full-snapshot fallback");
    } finally { g.dispose(); }
  } finally { f.dispose(); }
});
