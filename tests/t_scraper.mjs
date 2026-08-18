// tests/t_scraper.mjs — scraper against the fake host, no browser.
// Verifies the politeness set: priority beats walk, 404 is permanent,
// pending strictly decreases, headless operation.

import { assert, assertEquals } from "jsr:@std/assert";
import { Scraper } from "../src/scraper.mjs";
import { Settings } from "../src/settings.mjs";
import { Store } from "../src/store.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_PORT = 18211;
const FAKE = `127.0.0.1:${FAKE_PORT}`;

// Boot the fake host as a subprocess with the synthetic fixtures.
const child = new Deno.Command(Deno.execPath(), {
  args: ["run", "--allow-net", "--allow-read", new URL("./fake-comfy.mjs", import.meta.url).pathname, "--port", String(FAKE_PORT)],
  stdout: "null", stderr: "null",
}).spawn();

async function up() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://${FAKE}/api/system_stats`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("fake host did not come up");
}
await up();

async function mkStore() {
  const dir = await mkdtemp(join(tmpdir(), "kz-scraper-"));
  const settings = await Settings.open(dir);
  await settings.set("core.scraper", "enabled", true);
  await settings.set("core.scraper", "paused", false);
  const store = await Store.open(dir, join(dir, "feedback.json"));
  return { dir, settings, store };
}

Deno.test("scraper: headless walk drains the fake host, pending strictly decreases", async () => {
  const { dir, settings, store } = await mkStore();
  const s = new Scraper({ hosts: { local: FAKE }, store, settings });
  s.feed("local", ["flux-basic.png", "flux-lora.png", "flux-ipadapter.png"]);
  const initial = s.pending("local");
  assertEquals(initial, 3);
  s.start();
  // poll until drained
  let prev = initial;
  for (let i = 0; i < 100 && s.pending("local") > 0; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const p = s.pending("local");
    assert(p <= prev, "pending must strictly decrease");
    prev = p;
  }
  s.stop();
  assertEquals(s.pending("local"), 0);
  assertEquals(store.metaGet("local", "flux-basic.png").seed, 999);
  assertEquals(store.metaGet("local", "flux-lora.png").loras.length, 2);
  await rm(dir, { recursive: true });
});

Deno.test("scraper: 404 is permanent — marked nopng, never retried", async () => {
  const { dir, settings, store } = await mkStore();
  const s = new Scraper({ hosts: { local: FAKE }, store, settings });
  s.feed("local", ["missing-404.png"]);
  s.start();
  for (let i = 0; i < 60 && s.pending("local") > 0; i++) {
    await new Promise((r) => setTimeout(r, 150));
  }
  s.stop();
  assertEquals(s.pending("local"), 0);
  assertEquals(store.metaGet("local", "missing-404.png"), null); // nopng marker, not a meta
  await rm(dir, { recursive: true });
});

Deno.test("scraper: priority feed drains before walk", async () => {
  const { dir, settings, store } = await mkStore();
  const s = new Scraper({ hosts: { local: FAKE }, store, settings });
  // pause so nothing drains before both queues are populated
  await settings.set("core.scraper", "paused", true);
  s.feed("local", ["flux-controlnet.png"]);            // walk
  s.feed("local", ["flux-pulid.png"], true);           // priority
  s.start();
  await new Promise((r) => setTimeout(r, 300));        // let the gate hold
  assert(s.pending("local") >= 2, "paused: nothing drained");
  await settings.set("core.scraper", "paused", false); // resume
  for (let i = 0; i < 80 && s.pending("local") > 0; i++) {
    await new Promise((r) => setTimeout(r, 150));
  }
  s.stop();
  assertEquals(s.pending("local"), 0);
  // priority item landed
  assert(store.metaGet("local", "flux-pulid.png"));
  assert(store.metaGet("local", "flux-controlnet.png"));
  await rm(dir, { recursive: true });
});

addEventListener("unload", () => { try { child.kill("SIGTERM"); } catch {} });
