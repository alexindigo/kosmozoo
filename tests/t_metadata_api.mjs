// tests/t_metadata_api.mjs — the metadata channel: versioned poll, meta-want
// priority lane, downloads existence check.

import { assert, assertEquals } from "jsr:@std/assert";
import { makeRouter } from "../src/routes.mjs";
import { Settings } from "../src/settings.mjs";
import { Store } from "../src/store.mjs";
import { Prefetch } from "../src/prefetch.mjs";
import { Ingest } from "../src/ingest.mjs";
import { Cache } from "../src/cache.mjs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";async function ctx(dir, { downloadsDir } = {}) {
  const settings = await Settings.open(dir);
  const store = await Store.open(dir, join(dir, "feedback.json"));
  const hosts = { local: "127.0.0.1:1" };
  const router = makeRouter({ hosts, store, settings, plugins: null, downloadsDir });
  const scraper = new Prefetch({ hosts, store, settings, ingest: new Ingest(store, hosts, { cache: new Cache(join(dir, "cache")) }) });
  router.ctx = { hosts, store, settings, plugins: null, prefetch: scraper, downloadsDir };
  return { settings, store, router, scraper };
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
  const store = await Store.open(dir, join(dir, "fb.json"));
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
  router.ctx = { hosts, store, settings, plugins: null };
  const list = await (await router.handle(new Request("http://x/api/collections/local/entries"))).json();
  const bareEntry = list.find((i) => (i.name ?? i.filename) === "bare.png");
  assertEquals(bareEntry.extracted, true);
  assertEquals(bareEntry.meta, null);
  await rm(dir, { recursive: true });
});
