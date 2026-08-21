// tests/t_folder_host.mjs — a local folder registers as a host
// (name=folder:/abs/path) and everything works off it: probe, list, bytes
// with traversal guard, and metadata extraction via the full scraper path.

import { assert, assertEquals } from "jsr:@std/assert";
import { isFolderHost, validateHost, probeHost, hostList, hostReadBytes, hostKey } from "../src/hosts.mjs";
import { makeRouter } from "../src/routes.mjs";
import { Settings } from "../src/settings.mjs";
import { Store } from "../src/store.mjs";
import { Scraper } from "../src/scraper.mjs";
import { mkdtemp, rm, writeFile, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURES = new URL("./fixtures", import.meta.url).pathname;

Deno.test("folder host: validation, probe, list newest-first, traversal guard", async () => {
  assert(isFolderHost("folder:/tmp"));
  assertEquals(validateHost("fixtures", "folder:" + FIXTURES), null);
  assertEquals(validateHost("fixtures", "folder:"), "folder: needs a path");
  assertEquals(await probeHost("folder:" + FIXTURES), true);
  assertEquals(await probeHost("folder:/definitely/not/here"), false);

  // list: newest first by mtime
  const dir = await mkdtemp(join(tmpdir(), "kz-fold-"));
  const watched = ["a.png", "b.png", "c.svg"];
  for (const f of watched) {
    await writeFile(join(dir, f), "junk");
  }
  const now = Date.now();
  // a is oldest (3s back), c is middle (1s back), b is newest (now)
  await utimes(join(dir, "a.png"), new Date(now - 3000), new Date(now - 3000));
  await utimes(join(dir, "c.svg"), new Date(now - 1000), new Date(now - 1000));
  const list = await hostList("folder:" + dir);
  const pos = { a: list.indexOf("a.png"), b: list.indexOf("b.png"), c: list.indexOf("c.svg") };
  assert(pos.b < pos.c && pos.c < pos.a, "newest first");
  // hidden files skipped, non-renderables skipped
  await writeFile(join(dir, "not-an-image.txt"), "x");
  await writeFile(join(dir, ".hidden.png"), "x");
  const list2 = await hostList("folder:" + dir);
  assert(!list2.includes("not-an-image.txt"));
  assert(!list2.includes(".hidden.png"));
  await rm(dir, { recursive: true });

  // traversal guard: basename only, no ".."
  const t1 = await hostReadBytes("folder:" + FIXTURES, "../state.mjs");
  assertEquals(t1.status, 400);
  const t2 = await hostReadBytes("folder:" + FIXTURES, "logo.svg");
  assertEquals(t2.status, 200);
  assertEquals(t2.headers.get("Content-Type"), "image/svg+xml");
  const t3 = await hostReadBytes("folder:" + FIXTURES, "flux-basic.png");
  assertEquals(t3.status, 200);
  assertEquals(t3.headers.get("Content-Type"), "image/png");
  const t4 = await hostReadBytes("folder:" + FIXTURES, "nope.png");
  assertEquals(t4.status, 404);
});

Deno.test("folder host: routes serve the folder's files and bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-fr-"));
  const settings = await Settings.open(dir);
  const store = await Store.open(dir, join(dir, "feedback.json"));
  const router = makeRouter({ hosts: { fixtures: "folder:" + FIXTURES }, store, settings, plugins: null });

  const r = await router.handle(new Request("http://x/api/images?host=fixtures"));
  assertEquals(r.status, 200);
  const names = (await r.json()).map((i) => i.filename ?? i);
  assert(names.includes("flux-basic.png"));
  assert(names.includes("logo.svg"));

  const b = await router.handle(new Request("http://x/api/images/fixtures:logo.svg/bytes"));
  assertEquals(b.status, 200);
  assertEquals(b.headers.get("Content-Type"), "image/svg+xml");
  await b.arrayBuffer();

  const guard = await router.handle(new Request("http://x/api/images/fixtures:..%2fstate.mjs/bytes"));
  assertEquals(guard.status, 400);
  await guard.arrayBuffer();
  await rm(dir, { recursive: true });
});

Deno.test("folder host: the scraper path extracts metadata from ComfyUI PNGs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-fs-"));
  const settings = await Settings.open(dir);
  const store = await Store.open(dir, join(dir, "feedback.json"));
  const hosts = { fixtures: "folder:" + FIXTURES };
  const s = new Scraper({ hosts, store, settings });
  s.feed("fixtures", ["flux-basic.png", "flux-lora.png"]);
  s.start();
  for (let i = 0; i < 100 && s.pending("fixtures") > 0; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  s.stop();
  assertEquals(s.pending("fixtures"), 0);
  assertEquals(store.metaGet("fixtures", "flux-basic.png").seed, 999);
  assert(store.metaGet("fixtures", "flux-basic.png").prompt.includes("portrait"));
  await rm(dir, { recursive: true });
});
