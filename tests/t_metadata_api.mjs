// tests/t_metadata_api.mjs — the metadata channel: versioned poll, meta-want
// priority lane, downloads existence check; and the listing's one-statement
// contract (no per-entry queries at 3000 files).

import { assert, assertEquals } from "jsr:@std/assert";
import { makeRouter } from "../src/routes.mjs";
import { Settings } from "../src/settings.mjs";
import { Store } from "../src/store.mjs";
import { Prefetch } from "../src/prefetch.mjs";
import { Ingest } from "../src/ingest.mjs";
import { Cache } from "../src/cache.mjs";
import { mkStateRig, makeTestInventory } from "./helpers/rig.mjs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function ctx(dir) {
  const rig = await mkStateRig("meta", { dir });
  const hosts = { local: "127.0.0.1:1" };
  const ingest = new Ingest(rig.store, hosts, { cache: rig.cache });
  const scraper = new Prefetch({ hosts, store: rig.store, settings: rig.settings, ingest });
  const router = makeRouter({ hosts, inventory: makeTestInventory(hosts), store: rig.store, settings: rig.settings, plugins: null, cache: rig.cache, ingest, prefetch: scraper });
  return { settings: rig.settings, store: rig.store, router, scraper };
}

Deno.test("entry meta: generation timing is additive, path-specific and source/content fenced", async () => {
  const rig = await mkStateRig("generation-record");
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const hosts = { local: "fake:8188" };
  const inventory = makeTestInventory(hosts);
  const requests = [];
  let timing = () => held;
  const router = makeRouter({ hosts, inventory, store: rig.store, settings: rig.settings, plugins: null,
    cache: rig.cache, ingest: rig.ingest, prefetch: {}, comfy: () => ({ generationTime: name => { requests.push(name); return timing(); } }) });
  try {
    await rig.store.ingestFile("local", "nested/a.png", "aa".repeat(32), 10);
    await rig.store.metaPut("local", "nested/a.png", { seed: 1 }, { ext: 1 });
    const pending = router.handle(new Request("http://x/api/collections/local/entries/nested%2Fa.png/meta"));
    await Promise.resolve(); await Promise.resolve();
    release(140138);
    const response = await pending; assertEquals(response.status, 200);
    const record = await response.json();
    assertEquals(record.generationTimeMs, 140138); assertEquals(record.meta.seed, 1);
    assertEquals(requests, ["nested/a.png"]);
    timing = async () => {
      await rig.store.ingestFile("local", "nested/a.png", "bb".repeat(32), 10);
      return 140138;
    };
    const changed = await router.handle(new Request("http://x/api/collections/local/entries/nested%2Fa.png/meta"));
    assertEquals(changed.status, 409);
  } finally { release(null); await rig.close(); }
});

Deno.test("metadata: version bumps on write; items are per-host, nulls skipped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-meta-"));
  const { store, router } = await ctx(dir);
  const r0 = await router.handle(new Request("http://x/api/collections/local/meta"));
  const b0 = await r0.json();
  assert(b0.v > 0); // kv-seeded monotonic version
  assertEquals(b0.items, {});

  // meta is content state: the file is ingested (hashed) first, then written
  await store.ingestFile("local", "a.png", "aa".repeat(32), 10);
  await store.ingestFile("local", "b.png", "bb".repeat(32), 10);
  await store.metaPut("local", "a.png", { seed: 1 }, { ext: 1 });
  await store.metaPut("local", "b.png", null, { ext: 1 }); // no meta (was: nopng)
  const b1 = await (await router.handle(new Request("http://x/api/collections/local/meta"))).json();
  assertEquals(b1.v, b0.v + 4); // one bump per write (2 ingests + 2 puts)
  assertEquals(b1.items["a.png"].seed, 1);
  assertEquals(b1.items["b.png"], undefined); // no-meta rows don't leak
  await rm(dir, { recursive: true });
});

Deno.test("meta-want: files jump to the priority lane; pending reported", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-want-"));
  const { router, scraper } = await ctx(dir);
  const r = await router.handle(new Request("http://x/api/collections/local/want", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ host: "local", files: ["x.png", "y.png"] }),
  }));
  const body = await r.json();
  assertEquals(body.pending, 2);
  // they are in the PRIORITY queue (drains before the background walk)
  assertEquals(scraper.pending("local"), 2);
  const w = scraper.workers.get("local");
  assertEquals(w.prio.length, 2);
  assertEquals(w.walk.length, 0);
  await rm(dir, { recursive: true });
});

Deno.test("metadata delta: changed identities include content aliases, not unchanged rows; restart falls back", async () => {
  const rig = await mkStateRig("meta-delta", {});
  let store = rig.store;
  try {
    await store.ingestFile("a", "one.png", "aa".repeat(32), 10);
    await store.ingestFile("b", "alias.png", "aa".repeat(32), 10);
    await store.entryDimsPut("a", "unchanged.png", { width: 2, height: 3 });
    const since = store.metaVersion;
    await store.metaPut("a", "one.png", { seed: 7 });
    await store.entryDimsPut("a", "new.png", { width: 64, height: 32 });
    const delta = store.metadataSince("a", since);
    assertEquals(Object.keys(delta.items), ["one.png"]);
    assertEquals(delta.dims, { "new.png": { width: 64, height: 32 } });
    assertEquals(store.metadataSince("b", since).items, { "alias.png": { seed: 7 } });
    assertEquals(store.metadataSince("a", store.metaVersion), { v: store.metaVersion, changed: false });
    assertEquals(store.metadataSince("a").dims["unchanged.png"], { width: 2, height: 3 });
    const beforeAlias = store.metaVersion;
    await store.ingestFile("a", "another.png", "aa".repeat(32), 10);
    assertEquals(store.metadataSince("b", beforeAlias).items, {}, "unchanged content aliases are not republished on every byte acquisition");
    assertEquals(store.metadataSince("a", beforeAlias).items, { "another.png": { seed: 7 } });
    const version = store.metaVersion;
    store.close();
    store = await Store.open(rig.dir);
    const fallback = store.metadataSince("a", since);
    assertEquals(fallback.v, version);
    assertEquals(fallback.dims["unchanged.png"], { width: 2, height: 3 });
    assertEquals(store.metadataSince("a", version + 100).dims, fallback.dims);
  } finally { if (store !== rig.store) store.close(); await rig.close(); }
});

Deno.test("meta-want: dimensions-only background intent does not enqueue ingestion; options validate before mutation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-want-dims-"));
  const { router, scraper } = await ctx(dir);
  const post = body => router.handle(new Request("http://x/api/collections/local/want", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  try {
    for (const options of [{ interest: "invalid" }, { priority: "invalid" }, { priority: null }]) {
      assertEquals((await post({ files: ["bad.png"], ...options })).status, 400);
      assertEquals(scraper.workers.size, 0);
    }
    const response = await post({ files: ["a.png", "b.png"], interest: "dimensions", priority: "background" });
    assertEquals((await response.json()).pending, 2);
    const worker = scraper.workers.get("local");
    assertEquals(worker.dimsWalk, ["a.png", "b.png"]);
    assertEquals(worker.walk, []);
    assertEquals(worker.prio, []);
    await post({ files: ["b.png"] });
    assertEquals(worker.dimsPrio, ["b.png"]);
    assertEquals(worker.prio, ["b.png"]);
    const poll = await (await router.handle(new Request(`http://x/api/collections/local/meta?since=${router.ctx.store.metaVersion}`))).json();
    assertEquals(poll.changed, false);
    assert(poll.pending >= 2, "unchanged reads still report dimension work");
  } finally { await rm(dir, { recursive: true }); }
});

Deno.test("bytes priority: explicit background uses low; legacy requests remain foreground", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-byte-priority-"));
  const { router } = await ctx(dir), priorities = [];
  router.ctx.ingest.ensure = async (_id, _name, _kind, options) => {
    priorities.push(options.priority); return { status: 404 };
  };
  try {
    for (const query of ["?priority=background", "", "?priority=foreground", "?priority=invalid"]) {
      const response = await router.handle(new Request(`http://x/api/collections/local/entries/a.png/bytes${query}`));
      assertEquals(response.status, query.endsWith("invalid") ? 400 : 404);
    }
    assertEquals(priorities, ["low", "high", "high"]);
  } finally { await rm(dir, { recursive: true }); }
});

Deno.test("nodes registry: extraction populates /api/nodes with type→fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-nodes-reg-"));
  const { store, router, scraper } = await ctx(dir);
  // one walk extraction of a fixture with a whole graph
  const { readFile } = await import("node:fs/promises");
  const FIXTURES = new URL("./fixtures", import.meta.url).pathname;
  const hosts = { local: `folder:${FIXTURES}` };
  const sc = new Prefetch({ hosts, store, settings: await Settings.open(dir), ingest: new Ingest(store, hosts, { cache: new Cache(join(dir, "cache")) }) });
  sc.feed("local", ["flux-lora.png"], true);
  sc.start();
  for (let i = 0; i < 40 && store.nodeRegistry().LoraLoader === undefined; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  sc.stop();
  const reg = await (await router.handle(new Request("http://x/api/nodes"))).json();
  assert(reg.LoraLoader.inputs.strength_model === "number");
  assert(reg.SaveImage.inputs.filename_prefix === "string");
  await rm(dir, { recursive: true, force: true });
});

Deno.test("metaState: pending vs extracted vs none", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-mstate-"));
  const store = await Store.open(dir, { feedbackPath: join(dir, "fb.json") });
  const folder = join(dir, "images");
  await mkdir(folder);
  // never touched: pending
  assertEquals(store.metaState("local", "nope.png").extracted, false);
  // ingested + walked with meta: extracted + meta
  await store.ingestFile("local", "has.png", "aa".repeat(32), 10);
  await store.metaPut("local", "has.png", { seed: 1 }, { ext: 1 });
  const has = store.metaState("local", "has.png");
  assertEquals(has.extracted, true);
  assertEquals(has.meta.seed, 1);
  // ingested + walked with no meta: extracted + none (was: nopng marker)
  await store.ingestFile("local", "bare.png", "bb".repeat(32), 10);
  await store.metaPut("local", "bare.png", null, { ext: 1 });
  const bare = store.metaState("local", "bare.png");
  assertEquals(bare.extracted, true);
  assertEquals(bare.meta, null);
  // the listing carries the extracted flag
  await writeFile(join(folder, "bare.png"), "x");
  const settings = await Settings.open(dir);
  const hosts = { local: `folder:${folder}` };
  const router = makeRouter({ hosts, store, settings, plugins: null, inventory: makeTestInventory(hosts) });
  const list = await (await router.handle(new Request("http://x/api/collections/local/entries"))).json();
  const bareEntry = list.find((i) => (i.name ?? i.filename) === "bare.png");
  assertEquals(bareEntry.extracted, true);
  assertEquals(bareEntry.meta, null);
  await rm(dir, { recursive: true });
});

Deno.test("listing: one statement per listing — no per-entry queries at 3000 files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-list1-"));
  const names = Array.from({ length: 3000 }, (_, i) => `img-${String(i).padStart(4, "0")}.png`);
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
    if (req.method === "HEAD") return new Response(null, { headers: { "Last-Modified": "Thu, 01 Jan 1970 00:00:00 GMT" } });
    if (new URL(req.url).pathname === "/internal/files/output") return Response.json(names);
    return new Response("nf", { status: 404 });
  });
  try {
    const settings = await Settings.open(dir);
    const store = await Store.open(dir, { feedbackPath: join(dir, "fb.json") });
    const hosts = { local: `127.0.0.1:${server.addr.port}` };
    const cache = new Cache(join(dir, "cache"));
    const ingest = new Ingest(store, hosts, { cache });
    const router = makeRouter({ hosts, store, settings, plugins: null, cache, ingest, inventory: makeTestInventory(hosts) });
    // a few rows so the join carries judgment + dims
    await store.ingestFile("local", names[0], "aa".repeat(32), 100);
    await store.judgmentPatch("local", names[0], { vote: "up" });
    await store.entryDimsPut("local", names[1], { width: 64, height: 32 });

    // count the store's queries during one listing
    const calls = {};
    for (const m of ["entryGet", "metaState", "contentGet", "judgmentGet", "entryJoined", "entriesForCollection"]) {
      calls[m] = 0;
      const orig = store[m].bind(store);
      store[m] = (...a) => { calls[m]++; return orig(...a); };
    }
    const r = await router.handle(new Request("http://x/api/collections/local/entries"));
    const list = await r.json();
    assertEquals(list.length, 3000);
    assertEquals(calls.entriesForCollection, 1); // ONE statement
    assertEquals(calls.entryJoined, 0);
    assertEquals(calls.entryGet + calls.metaState + calls.contentGet + calls.judgmentGet, 0);
    // the join actually delivered judgment + dims
    assertEquals(list[0].judgment, { vote: "up" });
    const dimmed = list.find((e) => e.name === names[1]);
    assertEquals(dimmed.width, 64);
    assertEquals(dimmed.height, 32);
  } finally {
    await server.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

Deno.test("meta-want: the acknowledgement carries demanded names' known state, independent of any cursor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-want-state-"));
  const { store, router } = await ctx(dir);
  const post = body => router.handle(new Request("http://x/api/collections/local/want", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  try {
    await store.ingestFile("local", "a.png", "aa".repeat(32), 10, { dims: { width: 64, height: 32 } });
    await store.metaPut("local", "a.png", { seed: 3 }, { ext: 1 });
    const full = await (await post({ files: ["a.png", "missing.png"] })).json();
    assertEquals(full.items, { "a.png": { seed: 3 } });
    assertEquals(full.dims, { "a.png": { width: 64, height: 32 } });
    const dims = await (await post({ files: ["a.png"], interest: "dimensions", priority: "background" })).json();
    assertEquals(dims.items, {}, "dimension interest never ships graph metadata");
    assertEquals(dims.dims, { "a.png": { width: 64, height: 32 } });
  } finally { await rm(dir, { recursive: true }); }
});

for (const kind of ["input", "temp"]) for (const recovery of [false, true]) Deno.test(`metadata: ${kind} content facts reach output aliases including same name (cache ${recovery})`, async () => {
  const { testPng } = await import("./helpers/png.mjs");
  const { sha256 } = await import("../src/cache.mjs");
  const bytes = testPng(70, 50), hash = await sha256(bytes), dims = { width: 70, height: 50 };
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, req => {
    if (req.method === "HEAD") return new Response(null, { headers: { "Last-Modified": "Thu, 01 Jan 1970 00:00:00 GMT" } });
    if (new URL(req.url).pathname === "/internal/files/output") return Response.json(["same.png", "alias.png"]);
    return new Response("nf", { status: 404 });
  });
  const addr = `127.0.0.1:${server.addr.port}`;
  const r = await mkStateRig("dims-alias", { hosts: { c: addr, other: addr } });
  const router = makeRouter({ hosts: r.hosts, inventory: r.inventory, store: r.store, settings: r.settings, plugins: null,
    ingest: r.ingest, cache: r.cache, prefetch: { feed() {}, pending: () => 0, dimsPending: () => 0 } });
  try {
    await r.store.ingestFile("c", "same.png", hash, bytes.length);
    await r.store.ingestFile("other", "alias.png", hash, bytes.length);
    const since = r.store.metaVersion;
    if (recovery) {
      r.store.resourceCachePut("c", "same.png", kind, hash, null, bytes.length);
      await r.cache.put(hash, bytes);
      await r.ingest.dims("c", "same.png", kind);
    } else await r.ingest.ensureBytes("c", "same.png", bytes, { kind });
    for (const [host, name] of [["c", "same.png"], ["other", "alias.png"]]) {
      assertEquals(r.store.metadataSince(host, since).dims, { [name]: dims });
      assertEquals(r.store.metadataFor(host, [name]).dims, { [name]: dims });
      assertEquals(r.store.entriesForCollection(host)[0].width, 70);
      assertEquals(r.store.metadataSince(host, since).items, {}, "geometry publication does not fabricate extraction");
      const get = async path => (await router.handle(new Request(`http://x/api/collections/${host}/${path}`))).json();
      assertEquals((await get(`meta?since=${since}`)).dims, { [name]: dims });
      const want = await router.handle(new Request(`http://x/api/collections/${host}/want`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files: [name], interest: "dimensions" }),
      }));
      assertEquals((await want.json()).dims, { [name]: dims });
      const entry = (await get("entries")).find(row => row.name === name);
      assertEquals([entry.width, entry.height], [70, 50]);
    }
    await r.ingest.ensureBytes("c", "referenced-only.png", testPng(40, 10), { kind });
    assertEquals(r.store.entriesForCollection("c").map(row => row.name), ["same.png"]);
    assertEquals(r.store.contentGet(hash).ext, 0);
    assertEquals(r.store.contentGet(hash).meta, null);
  } finally { await server.shutdown(); await r.close(); }
});

Deno.test("entry meta: a shown entry's record ingests that one entry on demand; an unreadable one replies unextracted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-entry-meta-"));
  const folder = join(dir, "images");
  await mkdir(folder);
  const { readFile } = await import("node:fs/promises");
  await writeFile(join(folder, "graph.png"), await readFile(new URL("./fixtures/flux-lora.png", import.meta.url)));
  const rig = await mkStateRig("entry-meta", { dir: join(dir, "state"), hosts: { local: `folder:${folder}` } });
  const ensures = [];
  const ingest = { ensure: (...args) => { ensures.push(args); return rig.ingest.ensure(...args); } };
  const router = makeRouter({ hosts: rig.hosts, inventory: rig.inventory, store: rig.store, settings: rig.settings, plugins: null, cache: rig.cache, ingest });
  const read = async name => {
    const response = await router.handle(new Request(`http://x/api/collections/local/entries/${encodeURIComponent(name)}/meta`));
    assertEquals(response.status, 200);
    return response.json();
  };
  try {
    const v = rig.store.metaVersion;
    const record = await read("graph.png");
    assertEquals(record.name, "graph.png");
    assertEquals(record.extracted, true);
    assert(record.hash, "the entry was ingested for its reader");
    assert(record.meta.nodes.some(node => node.type === "LoraLoader"), "the record is the extracted graph");
    assertEquals([ensures[0][0], ensures[0][1], ensures[0][3]], ["local", "graph.png", { priority: "high" }]);
    assert(rig.store.metaVersion > v, "the ordinary write path versioned it for the collection stream too");
    assertEquals((await read("graph.png")).hash, record.hash);
    assertEquals(ensures.length, 1, "a known record is answered without another read");
    const missing = await read("missing.png");
    assertEquals([missing.extracted, missing.hash, missing.meta], [false, null, null]);
  } finally { await rig.close(); await rm(dir, { recursive: true, force: true }); }
});

Deno.test("listing envelope: its metadata version continues the delta stream with exactly the later writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-listing-version-"));
  const folder = join(dir, "images");
  await mkdir(folder);
  for (const name of ["a.png", "b.png"]) await writeFile(join(folder, name), "x");
  const rig = await mkStateRig("listing-version", { dir: join(dir, "state"), hosts: { local: `folder:${folder}` } });
  const router = makeRouter({ hosts: rig.hosts, inventory: rig.inventory, store: rig.store, settings: rig.settings, plugins: null, cache: rig.cache, ingest: rig.ingest,
    prefetch: { pending: () => 0, dimsPending: () => 0 } });
  const get = async path => (await router.handle(new Request(`http://x${path}`))).json();
  try {
    await rig.store.ingestFile("local", "a.png", "aa".repeat(32), 1);
    await rig.store.metaPut("local", "a.png", { seed: 1 }, { ext: 1 });
    const listing = await get("/api/collections/local/entries?inventory=1");
    assertEquals(listing.metaVersion, rig.store.metaVersion);
    assertEquals(listing.entries.find(entry => entry.name === "a.png").meta, { seed: 1 });
    assertEquals(await get(`/api/collections/local/meta?since=${listing.metaVersion}`), { v: listing.metaVersion, changed: false, pending: 0 });
    await rig.store.ingestFile("local", "b.png", "bb".repeat(32), 1);
    await rig.store.metaPut("local", "b.png", { seed: 2 }, { ext: 1 });
    const delta = await get(`/api/collections/local/meta?since=${listing.metaVersion}`);
    assertEquals(delta.items, { "b.png": { seed: 2 } }, "only the write after the listing; never the collection");
  } finally { await rig.close(); await rm(dir, { recursive: true, force: true }); }
});
