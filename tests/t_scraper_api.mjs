// tests/t_scraper_api.mjs — scraper control + the per-collection judgment export.

import { assert, assertEquals } from "jsr:@std/assert";
import { makeRouter } from "../src/routes.mjs";
import { Settings } from "../src/settings.mjs";
import { Store } from "../src/store.mjs";
import { Prefetch } from "../src/prefetch.mjs";
import { Ingest } from "../src/ingest.mjs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function ctx(dir) {
  const settings = await Settings.open(dir);
  const store = await Store.open(dir);
  const hosts = { local: "127.0.0.1:1" };
  const router = makeRouter({ hosts, store, settings, plugins: null });
  const scraper = new Prefetch({ hosts, store, settings, ingest: new Ingest(store, hosts) });
  router.ctx = { hosts, store, settings, plugins: null, prefetch: scraper };
  return { settings, store, router, scraper };
}

Deno.test("scraper API: GET status, POST toggles enabled/paused persist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-scrapi-"));
  const { settings, router } = await ctx(dir);

  let r = await router.handle(new Request("http://x/api/scraper"));
  let body = await r.json();
  assertEquals(body.enabled, true);
  assertEquals(body.paused, false);
  assert("local" in body.pending);

  r = await router.handle(new Request("http://x/api/scraper", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: false, paused: true }),
  }));
  body = await r.json();
  assertEquals(body.enabled, false);
  assertEquals(body.paused, true);
  assertEquals(settings.get("core.scraper", "enabled"), false);
  assertEquals(settings.get("core.scraper", "paused"), true);
  await rm(dir, { recursive: true });
});

Deno.test("feedback export: per-collection v2 document on demand; 404 unknown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-fb-"));
  const { store, router } = await ctx(dir);
  await store.judgmentSet("local", "f.png", "vote", "up");
  await store.judgmentSet("local", "f.png", "notes", { pos: "colors" });
  const r = await router.handle(new Request("http://x/api/collections/local/feedback.json"));
  assertEquals(r.status, 200);
  assert(r.headers.get("Content-Disposition").includes("attachment"));
  const doc = JSON.parse(await r.text());
  assertEquals(doc.version, 2);
  assertEquals(doc.collection, "local");
  assertEquals(doc.entries["f.png"].vote, "up");
  assertEquals(doc.entries["f.png"].notes, { pos: "colors" });

  const nf = await router.handle(new Request("http://x/api/collections/nope/feedback.json"));
  assertEquals(nf.status, 404);

  // the old live-document routes are gone
  assertEquals((await router.handle(new Request("http://x/api/feedback"))).status, 404);
  assertEquals((await router.handle(new Request("http://x/api/feedback-path", { method: "PUT" }))).status, 404);
  await rm(dir, { recursive: true });
});
