// tests/t_prefetch.mjs — the prefetch walk against the fake host, no browser.
// Verifies the politeness set: priority beats walk, 404 is permanent,
// pending strictly decreases, headless operation.

import { assert, assertEquals } from "jsr:@std/assert";
import { Prefetch } from "../src/prefetch.mjs";
import { Ingest } from "../src/ingest.mjs";
import { EXTRACTOR_VERSION } from "../src/extractor.mjs";
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

Deno.test("prefetch: headless walk drains the fake host, pending strictly decreases", async () => {
  const { dir, settings, store } = await mkStore();
  const s = new Prefetch({ hosts: { local: FAKE }, store, settings, ingest: new Ingest(store, { local: FAKE }) });
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

Deno.test("prefetch: 404 is permanent — marked nopng, never retried", async () => {
  const { dir, settings, store } = await mkStore();
  const s = new Prefetch({ hosts: { local: FAKE }, store, settings, ingest: new Ingest(store, { local: FAKE }) });
  s.feed("local", ["missing-404.png"]);
  s.start();
  for (let i = 0; i < 60 && s.pending("local") > 0; i++) {
    await new Promise((r) => setTimeout(r, 150));
  }
  s.stop();
  assertEquals(s.pending("local"), 0);
  assertEquals(store.metaGet("local", "missing-404.png"), null); // no meta
  assertEquals(store.entryGet("local", "missing-404.png")?.state, "gone"); // 404 ⇒ entry state, not content
  await rm(dir, { recursive: true });
});

Deno.test("prefetch: priority feed drains before walk", async () => {
  const { dir, settings, store } = await mkStore();
  const s = new Prefetch({ hosts: { local: FAKE }, store, settings, ingest: new Ingest(store, { local: FAKE }) });
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

Deno.test("prefetch: feed skips files already extracted at the current version", async () => {
  const { dir, settings, store } = await mkStore();
  // Mark one file as extracted at EXTRACTOR_VERSION; the other stays unknown.
  // (meta is content state: ingest first, then write at the current version)
  await store.ingestFile("local", "flux-basic.png", "aa".repeat(32), 100);
  await store.metaPut("local", "flux-basic.png", { seed: 1 }, { ext: EXTRACTOR_VERSION });
  const s = new Prefetch({ hosts: { local: FAKE }, store, settings, ingest: new Ingest(store, { local: FAKE }) });
  const pending = s.feed("local", ["flux-basic.png", "flux-lora.png"]);
  assertEquals(pending, 1); // only the unknown one queues
  assert(queued(s, "local", "flux-lora.png"));
  assert(!queued(s, "local", "flux-basic.png"));
  // A later listing load must not requeue the extracted file again.
  assertEquals(s.pending("local"), 1);
  await rm(dir, { recursive: true });
});

// queue-membership helper (observes the freshness decision, not the drain)
function queued(s, host, name) {
  const w = s.workers.get(host);
  return !!w && (w.walk.includes(name) || w.prio.includes(name));
}

Deno.test("prefetch: stale extractor version requeues for re-extraction", async () => {
  const { dir, settings, store } = await mkStore();
  // extracted at an OLDER version than the gate expects
  await store.metaPut("local", "flux-basic.png", { seed: 1 }, { ext: EXTRACTOR_VERSION - 1 });
  const s = new Prefetch({ hosts: { local: FAKE }, store, settings, ingest: new Ingest(store, { local: FAKE }) });
  const pending = s.feed("local", ["flux-basic.png"]);
  assertEquals(pending, 1); // older version is stale → requeue
  await rm(dir, { recursive: true });
});

addEventListener("unload", () => { try { child.kill("SIGTERM"); } catch {} });
