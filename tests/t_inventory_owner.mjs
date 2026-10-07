import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { makeInventoryOwner } from "../src/backings/inventory-owner.mjs";
import { makeMetadataCollector } from "../src/backings/comfy-metadata.mjs";
import { makeCollectionInventory } from "../src/backings/index.mjs";
import { comfyClient } from "../src/backings/comfy.mjs";
import { createBinding as folderBinding } from "../src/backings/folder.mjs";
import { mkStateRig } from "./helpers/rig.mjs";
import { Prefetch } from "../src/prefetch.mjs";

const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const data = (atMs) => ({ records: [{ name: "nested/image.png", size: 12, modified: { atMs, precisionMs: null, source: "filesystem-stat" } }],
  discovered: ["nested/image.png"], coverage: "recursive", subfolders: { supported: true, reason: null } });
const tick = async (predicate) => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise((r) => setTimeout(r, 1)); } throw new Error("condition not reached"); };

Deno.test("inventory owner: immutable accepted cache, no constructor work, fresh/backdated replacement and failed-cache integrity", async () => {
  let clock = 0, calls = 0, date = 2000, fail = false;
  const owner = makeInventoryOwner({ clock: () => clock, collect: async () => { calls++; if (fail) throw new Error("metadata missing"); return data(date); } });
  try {
    assertEquals(calls, 0);
    const first = await owner.inventory();
    clock = 10;
    assertEquals(await owner.inventory({ maxAgeMs: 100 }), first); assertEquals(calls, 1);
    date = -1000;
    const next = await owner.inventory(); assertEquals(next.items[0].modified.atMs, -1000);
    fail = true;
    await assertRejects(() => owner.inventory());
    assertEquals(owner.peekInventory(), next);
    await assertRejects(() => owner.inventory({ maxAgeMs: 100 }));
    assertEquals(first.items[0].modified.atMs, 2000);
  } finally { await owner.disposeInventory(); }
});

Deno.test("inventory owner: initial invalidation gets one frozen follow-up, later readers/drain cannot starve the cohort", async () => {
  const waves = [], owner = makeInventoryOwner({ collect: ({ generation }) => { const gate = defer(); waves.push({ gate, generation }); return gate.promise; } });
  try {
    const one = owner.inventory(), alias = owner.inventory(); assertEquals(one, alias);
    await tick(() => waves.length === 1);
    owner.invalidateInventory(); owner.invalidateInventory();
    waves[0].gate.resolve(data(1));
    await tick(() => waves.length === 2);
    owner.invalidateInventory();
    const newer = owner.inventory();
    let newerResolved = false; newer.then(() => newerResolved = true);
    waves[1].gate.resolve(data(2));
    const completed = await one;
    assertEquals(completed.items[0].modified.atMs, 2);
    assertEquals(newerResolved, false);
    await tick(() => waves.length === 3);
    waves[2].gate.resolve(data(3));
    assertEquals((await newer).items[0].modified.atMs, 3);
    assert(waves[2].generation > completed.generation);
  } finally { for (const w of waves) w.gate.resolve(data(9)); await owner.disposeInventory(); }
});

Deno.test("inventory owner: ignored abort waits settle by wave deadline/disposal and late success cannot publish", async () => {
  const late = defer();
  const owner = makeInventoryOwner({ collect: () => late.promise, waveTimeoutMs: 15, readerTimeoutMs: 40 });
  await assertRejects(() => owner.inventory());
  assertEquals(owner.peekInventory(), null);
  await owner.disposeInventory(); late.resolve(data(100));
  await tick(() => true); assertEquals(owner.peekInventory(), null);
  const ignored = defer(), disposed = makeInventoryOwner({ collect: () => ignored.promise });
  const read = disposed.inventory(); const rejection = assertRejects(() => read);
  await disposed.disposeInventory(); await rejection;
  ignored.resolve(data(200)); assertEquals(disposed.peekInventory(), null);
});

Deno.test("metadata pool: four physical HEADs, queued cancellation, no body methods and observed late transports", async () => {
  const signal = new AbortController(), gates = [], requests = [];
  const pool = makeMetadataCollector({ signal: signal.signal, urlFor: (name) => "http://fake/" + name,
    fetcher: (url, options) => { const gate = defer(); gates.push(gate); requests.push({ url, options }); return gate.promise; } });
  const reads = Array.from({ length: 20 }, (_, i) => pool.observe("file" + i + ".png"));
  const all = Promise.allSettled(reads);
  await tick(() => gates.length === 4);
  assertEquals(pool.stats().peak, 4);
  assert(requests.every(({ options }) => options.method === "HEAD" && !options.headers.Range && options.headers["Accept-Encoding"] === "identity"));
  signal.abort(); await all;
  assertEquals(gates.length, 4); assertEquals(pool.stats().queued, 0); assertEquals(pool.stats().logicalActive, 0);
  for (const gate of gates) gate.resolve(new Response(null, { headers: { "Last-Modified": "Thu, 01 Jan 1970 00:00:00 GMT", "Content-Length": "12" } }));
  await tick(() => pool.stats().active === 0); pool.dispose();
});

Deno.test("metadata pool: typed 404 versus date/status/timeout failures", async () => {
  let mode = "present";
  const pool = makeMetadataCollector({ requestTimeoutMs: 10, urlFor: (name) => "http://fake/" + name, fetcher: async () => {
    if (mode === "ignored") return new Promise(() => {});
    if (mode === "404") return new Response(null, { status: 404 });
    if (mode === "403") return new Response(null, { status: 403 });
    return new Response(null, { headers: mode === "present" ? { "Last-Modified": "Thu, 01 Jan 1970 00:00:00 GMT" } : {} });
  } });
  try {
    assertEquals((await pool.observe("zero.png")).modified.atMs, 0);
    mode = "404"; assertEquals((await pool.observe("gone.png")).kind, "not-found");
    for (mode of ["date", "403", "ignored"]) await assertRejects(() => pool.observe("bad.png"));
  } finally { pool.dispose(); }
});

Deno.test("collection incarnation: alias keeps the owner alive but removed/re-added reader cannot consume old results", async () => {
  const gate = defer(); let heads = 0;
  const hosts = { h: "fake:1", alias: "fake:1" };
  const inventory = makeCollectionInventory(hosts, { bindingFactory: (address) => comfyClient(address, { fetcher: async (url, options) => {
    if (options?.method === "HEAD") { heads++; return gate.promise; }
    return new URL(url).pathname.endsWith("config") ? new Response(null, { status: 404 }) : Response.json(["file.png"]);
  } }) });
  try {
    const old = inventory("h"), alias = inventory("alias");
    const rejected = assertRejects(() => old);
    await tick(() => heads === 1);
    const token = inventory.capture("h");
    delete hosts.h; inventory.reconcile(); hosts.h = "fake:1"; inventory.reconcile();
    assert(!inventory.isCurrent(token));
    gate.resolve(new Response(null, { headers: { "Last-Modified": "Thu, 01 Jan 1970 00:00:00 GMT" } }));
    await rejected;
    const accepted = await alias;
    assertEquals((await inventory("h", { maxAgeMs: 1000 })).revision, accepted.revision);
    assertEquals(heads, 1);
  } finally { gate.resolve(new Response(null)); await inventory.stop(); }
});

Deno.test("folder owner: common chronology, metadata provenance, permission failure and ignored-abort stop", async () => {
  let mode = "good";
  const owner = folderBinding("folder:/unused", { enumerator: async () => ["z.png", "a.png"], statter: async () => {
    if (mode === "permission") throw Object.assign(new Error("denied"), { code: "EACCES" });
    return { isFile: () => true, size: 0, mtimeMs: 0 };
  } });
  try {
    const snapshot = await owner.inventory();
    assertEquals(snapshot.items.map((e) => e.name), ["a.png", "z.png"]);
    assertEquals(snapshot.items[0].modified, { atMs: 0, precisionMs: null, source: "filesystem-stat" });
    mode = "permission"; await assertRejects(() => owner.inventory());
    assertEquals(owner.peekInventory(), snapshot);
  } finally { await owner.disposeInventory(); }
  const pending = defer(), late = folderBinding("folder:/unused", { enumerator: async () => ["a.png"], statter: () => pending.promise });
  const read = late.inventory(), rejected = assertRejects(() => read);
  await late.disposeInventory(); await rejected;
  pending.resolve({ isFile: () => true, size: 0, mtimeMs: 0 });
  assertEquals(late.peekInventory(), null);
});

Deno.test("unavailable worker: cached/dimension-known image must still obtain fresh source evidence before gone", async () => {
  const hosts = { h: "fake:1" }, rig = await mkStateRig("unavailable-cached", { hosts });
  const png = await Deno.readFile(new URL("./fixtures/flux-basic.png", import.meta.url));
  await rig.ingest.ensureBytes("h", "cached.png", png);
  assert(rig.store.entryDims("h", "cached.png"));
  const snapshot = Object.freeze({ revision: "missing:1", items: [], unavailable: [{ name: "cached.png", status: 404, reason: "confirmed" }] });
  let observations = 0;
  const inventory = async () => snapshot;
  inventory.capture = rig.inventory.capture; inventory.isCurrent = rig.inventory.isCurrent;
  inventory.peek = () => snapshot;
  inventory.observeMetadata = async () => { observations++; return { kind: "not-found", status: 404 }; };
  const worker = new Prefetch({ hosts, settings: rig.settings, store: rig.store, ingest: rig.ingest, inventory,
    interFileDelayMs: 1, dimsInterFileDelayMs: 1, listRefreshMs: 3600000 });
  try {
    await worker.start(); await tick(() => rig.store.entryGet("h", "cached.png")?.state === "gone");
    assertEquals(observations, 1);
  } finally { await worker.stop(); await rig.close(); }
});

Deno.test("unavailable worker: newer presence invalidates an old delayed absence, never mutating the present entry", async () => {
  const hosts = { h: "fake:1" }, rig = await mkStateRig("unavailable-presence", { hosts });
  const png = await Deno.readFile(new URL("./fixtures/flux-basic.png", import.meta.url));
  await rig.ingest.ensureBytes("h", "cached.png", png);
  const missing = { revision: "missing:1", items: [], unavailable: [{ name: "cached.png", status: 404, reason: "confirmed" }] };
  let latest = missing, started = false;
  const gate = defer(), inventory = async () => latest;
  inventory.capture = rig.inventory.capture; inventory.isCurrent = rig.inventory.isCurrent;
  inventory.peek = () => latest;
  inventory.observeMetadata = async () => { started = true; return gate.promise; };
  const worker = new Prefetch({ hosts, settings: rig.settings, store: rig.store, ingest: rig.ingest, inventory,
    interFileDelayMs: 1, dimsInterFileDelayMs: 1, listRefreshMs: 3600000 });
  try {
    await worker.start(); await tick(() => started);
    latest = { revision: "present:2", items: [{ name: "cached.png" }], unavailable: [] };
    gate.resolve({ kind: "not-found", status: 404 });
    await tick(() => worker.workers.get("h").unavailable.length === 0);
    assertEquals(rig.store.entryGet("h", "cached.png").state, "ingested");
  } finally { gate.resolve({ kind: "not-found", status: 404 }); await worker.stop(); await rig.close(); }
});

Deno.test("prefetch relist: a request during the owner's follow-up is acknowledged only by its own subsequent read", async () => {
  const hosts = { h: "fake:1" }, rig = await mkStateRig("relist-follow", { hosts });
  const waves = [], owner = makeInventoryOwner({ collect: ({ generation }) => { const gate = defer(); waves.push({ gate, generation }); return gate.promise; } });
  const reads = [];
  const inventory = (...args) => { reads.push(args[1]); return owner.inventory(args[1]); };
  inventory.capture = rig.inventory.capture; inventory.isCurrent = rig.inventory.isCurrent;
  inventory.peek = owner.peekInventory;
  const empty = () => ({ ...data(0), records: [], discovered: [] });
  const worker = new Prefetch({ hosts, settings: rig.settings, store: rig.store, ingest: rig.ingest, inventory, listRefreshMs: 17 });
  try {
    await worker.start(); await tick(() => waves.length === 1);
    owner.invalidateInventory(); worker.requestRelist("h");
    waves[0].gate.resolve(empty()); await tick(() => waves.length === 2);
    owner.invalidateInventory(); worker.requestRelist("h");
    waves[1].gate.resolve(empty()); await tick(() => waves.length === 3);
    waves[2].gate.resolve(empty());
    await tick(() => worker.workers.get("h").acknowledged === worker.workers.get("h").requested);
    assertEquals(reads[0].maxAgeMs, 17); assertEquals(reads[1].maxAgeMs, 0);
    assert(reads.length >= 2);
  } finally { for (const wave of waves) wave.gate.resolve(empty()); await owner.disposeInventory(); await worker.stop(); await rig.close(); }
});

Deno.test("prefetch pause: a pause during metadata collection prevents byte work after the awaited listing", async () => {
  const rig = await mkStateRig("pause-chronology", { hosts: { h: "fake:1" } });
  const gate = defer(); let started = false, dims = 0;
  const inventory = () => { started = true; return gate.promise; };
  inventory.capture = rig.inventory.capture; inventory.isCurrent = rig.inventory.isCurrent;
  const worker = new Prefetch({ hosts: rig.hosts, settings: rig.settings, store: rig.store,
    ingest: { dims: async () => { dims++; return { status: 200, dims: { w: 1, h: 1 } }; },
      ensure: async () => ({ status: 200 }) }, inventory, listRefreshMs: 3600000 });
  try {
    await worker.start(); await tick(() => started);
    await rig.settings.set("core.prefetch", "paused", true);
    gate.resolve({ ...data(0), items: [{ name: "image.png" }], unavailable: [] });
    await new Promise(r => setTimeout(r, 100));
    assertEquals(dims, 0, "no byte request may launch using the pre-await pause state");
    await rig.settings.set("core.prefetch", "paused", false);
    for (let i = 0; i < 150 && !dims; i++) await new Promise(r => setTimeout(r, 10));
    assertEquals(dims, 1);
  } finally { gate.resolve({ items: [], unavailable: [] }); await worker.stop(); await rig.close(); }
});
