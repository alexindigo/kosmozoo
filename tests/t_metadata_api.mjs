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
import { mkStateRig } from "./helpers/rig.mjs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function ctx(dir) {
  const rig = await mkStateRig("meta", { dir });
  const hosts = { local: "127.0.0.1:1" };
  const ingest = new Ingest(rig.store, hosts, { cache: rig.cache });
  const scraper = new Prefetch({ hosts, store: rig.store, settings: rig.settings, ingest });
  const router = makeRouter({ hosts, store: rig.store, settings: rig.settings, plugins: null, cache: rig.cache, ingest, prefetch: scraper });
  return { settings: rig.settings, store: rig.store, router, scraper };
}

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
  const router = makeRouter({ hosts, store, settings, plugins: null });
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
    if (new URL(req.url).pathname === "/internal/files/output") return Response.json(names);
    return new Response("nf", { status: 404 });
  });
  try {
    const settings = await Settings.open(dir);
    const store = await Store.open(dir, { feedbackPath: join(dir, "fb.json") });
    const hosts = { local: `127.0.0.1:${server.addr.port}` };
    const cache = new Cache(join(dir, "cache"));
    const ingest = new Ingest(store, hosts, { cache });
    const router = makeRouter({ hosts, store, settings, plugins: null, cache, ingest });
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
