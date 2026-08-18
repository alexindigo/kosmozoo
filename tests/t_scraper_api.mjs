// tests/t_scraper_api.mjs — scraper control + feedback document routes.

import { assert, assertEquals } from "jsr:@std/assert";
import { makeRouter } from "../src/routes.mjs";
import { Settings } from "../src/settings.mjs";
import { Store } from "../src/store.mjs";
import { Scraper } from "../src/scraper.mjs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function ctx(dir) {
  const settings = await Settings.open(dir);
  const store = await Store.open(dir, join(dir, "feedback.json"));
  const hosts = { local: "127.0.0.1:1" };
  const router = makeRouter({ hosts, store, settings, plugins: null });
  const scraper = new Scraper({ hosts, store, settings });
  router.ctx = { hosts, store, settings, plugins: null, scraper };
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

Deno.test("feedback API: download serves the exact stored document", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-fb-"));
  const { store, router } = await ctx(dir);
  await store.judgmentSet("h", "f.png", "vote", "up");
  const r = await router.handle(new Request("http://x/api/feedback"));
  assertEquals(r.status, 200);
  assert(r.headers.get("Content-Disposition").includes("attachment"));
  const doc = JSON.parse(await r.text());
  assertEquals(doc.version, 1);
  assertEquals(doc.data["h:f.png"].vote, "up");
  await rm(dir, { recursive: true });
});

Deno.test("feedback path: PUT re-opens the store at the new path live", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-fbpath-"));
  const { store, settings, router } = await ctx(dir);
  await store.judgmentSet("h", "a.png", "vote", "down");

  const newPath = join(dir, "elsewhere", "feedback.json");
  const r = await router.handle(new Request("http://x/api/feedback-path", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: newPath }),
  }));
  assertEquals(r.status, 200);
  assertEquals(store.feedbackPath, newPath);
  assertEquals(settings.get("core", "feedbackPath"), newPath);

  // writes now land in the NEW file
  await store.judgmentSet("h", "b.png", "vote", "up");
  const moved = JSON.parse(await readFile(newPath, "utf-8"));
  assertEquals(moved.data["h:b.png"].vote, "up");
  await rm(dir, { recursive: true });
});
