// tests/t_metadata_api.mjs — the metadata channel: versioned poll, meta-want
// priority lane, downloads existence check.

import { assert, assertEquals } from "jsr:@std/assert";
import { makeRouter } from "../src/routes.mjs";
import { Settings } from "../src/settings.mjs";
import { Store } from "../src/store.mjs";
import { Scraper } from "../src/scraper.mjs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function ctx(dir, { downloadsDir } = {}) {
  const settings = await Settings.open(dir);
  const store = await Store.open(dir, join(dir, "feedback.json"));
  const hosts = { local: "127.0.0.1:1" };
  const router = makeRouter({ hosts, store, settings, plugins: null, downloadsDir });
  const scraper = new Scraper({ hosts, store, settings });
  router.ctx = { hosts, store, settings, plugins: null, scraper, downloadsDir };
  return { settings, store, router, scraper };
}

Deno.test("metadata: version bumps on write; items are per-host, nulls skipped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-meta-"));
  const { store, router } = await ctx(dir);
  const r0 = await router.handle(new Request("http://x/api/metadata?host=local"));
  const b0 = await r0.json();
  assertEquals(b0.v, 0);
  assertEquals(b0.items, {});

  await store.metaPut("local", "a.png", { seed: 1 }, { ext: 1 });
  await store.metaPut("local", "b.png", null, { nopng: true, ext: 1 }); // negative marker
  const b1 = await (await router.handle(new Request("http://x/api/metadata?host=local"))).json();
  assertEquals(b1.v, 2); // one bump per write
  assertEquals(b1.items["a.png"].seed, 1);
  assertEquals(b1.items["b.png"], undefined); // nopng not leaked as meta
  await rm(dir, { recursive: true });
});

Deno.test("meta-want: files jump to the priority lane; pending reported", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-want-"));
  const { router, scraper } = await ctx(dir);
  const r = await router.handle(new Request("http://x/api/meta-want", {
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

Deno.test("downloads-check: reports which filenames exist in the downloads dir", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-dl-"));
  const dl = join(dir, "Downloads");
  await mkdir(dl);
  await writeFile(join(dl, "saved.png"), "");
  const { router } = await ctx(dir, { downloadsDir: dl });
  const r = await router.handle(new Request("http://x/api/downloads-check", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ files: ["saved.png", "nope.png"] }),
  }));
  const body = await r.json();
  assertEquals(body.exists, { "saved.png": true, "nope.png": false });
  await rm(dir, { recursive: true, force: true });
});
