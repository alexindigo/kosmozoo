// tests/t_engine_core.mjs — Phase 4 contract tests: state, settings, store,
// host proxy, API surface. Runs the engine in-process against the fake host.

import { assert, assertEquals } from "jsr:@std/assert";
import { ensureStateDir, loadVersioned, atomicWrite } from "../src/state.mjs";
import { Settings } from "../src/settings.mjs";
import { Store } from "../src/store.mjs";
import { parseHosts, hostKey, splitHostKey } from "../src/hosts.mjs";
import { makeRouter } from "../src/routes.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- state ---------------------------------------------------------------

Deno.test("state: versioned doc round-trips and migrates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-state-"));
  const path = join(dir, "doc.json");
  await atomicWrite(path, new TextEncoder().encode(JSON.stringify({ version: 0, data: { a: 1 } })));
  const doc = await loadVersioned(path, {
    current: 1,
    empty: () => ({}),
    migrations: { 0: (d) => ({ ...d, b: 2 }) },
  });
  assertEquals(doc.version, 1);
  assertEquals(doc.data, { a: 1, b: 2 });
  await rm(dir, { recursive: true });
});

Deno.test("state: ensureStateDir falls back to XDG when preferred is read-only", async () => {
  const dir = await ensureStateDir("/proc/definitely-not-writable");
  assert(dir.includes(".local/state/kosmozoo") || dir.includes("kosmozoo"));
});

// --- hosts ---------------------------------------------------------------

Deno.test("hosts: parse KOZMOZOO_HOSTS, hostKey round-trip", () => {
  const hosts = parseHosts({ KOZMOZOO_HOSTS: "a=1.2.3.4:8188, b=host2:8188" });
  assertEquals(hosts, { a: "1.2.3.4:8188", b: "host2:8188" });
  const k = hostKey("a", "img.png");
  assertEquals(k, "a:img.png");
  assertEquals(splitHostKey(k), ["a", "img.png"]);
});

// --- settings ------------------------------------------------------------

Deno.test("settings: namespaced set/get, null deletes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-settings-"));
  const s = await Settings.open(dir);
  await s.set("core.judgment", "downvoteHides", true);
  await s.set("plugins.export", "bucket", "alisa_good");
  assertEquals(s.get("core.judgment", "downvoteHides"), true);
  assertEquals(s.get("plugins.export", "bucket"), "alisa_good");
  await s.set("plugins.export", "bucket", null);
  assertEquals(s.get("plugins.export", "bucket"), null);
  // persisted
  const s2 = await Settings.open(dir);
  assertEquals(s2.get("core.judgment", "downvoteHides"), true);
  await rm(dir, { recursive: true });
});

// --- store ---------------------------------------------------------------

Deno.test("store: judgment defaults stored absent, entry prunes when empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-store-"));
  const fb = join(dir, "feedback.json");
  const st = await Store.open(dir, fb);
  await st.judgmentSet("h", "f.png", "vote", "down");
  assertEquals(st.judgmentGet("h", "f.png"), { vote: "down" });
  await st.judgmentSet("h", "f.png", "vote", null);
  assertEquals(st.judgmentGet("h", "f.png"), null); // fully empty -> pruned
  // plugin fields namespaced
  await st.judgmentSet("h", "g.png", "plugins.export.bucket", "alisa_good");
  assertEquals(st.judgmentGet("h", "g.png"), { plugins: { export: { bucket: "alisa_good" } } });
  await st.judgmentSet("h", "g.png", "plugins.export.bucket", null);
  assertEquals(st.judgmentGet("h", "g.png"), null); // plugin ns pruned too
  await rm(dir, { recursive: true });
});

// --- API surface ---------------------------------------------------------

Deno.test("api: /api/hosts probes online status; unknown routes 404", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-api-"));
  const settings = await Settings.open(dir);
  const store = await Store.open(dir, join(dir, "feedback.json"));
  const router = makeRouter({ hosts: { local: "127.0.0.1:1" }, store, settings, plugins: null });
  const res = await router.handle(new Request("http://x/api/hosts"));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.local.online, false); // nothing on port 1
  const nf = await router.handle(new Request("http://x/api/nope"));
  assertEquals(nf.status, 404);
  await rm(dir, { recursive: true });
});

Deno.test("api: settings namespace round-trip via HTTP", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-api2-"));
  const settings = await Settings.open(dir);
  const store = await Store.open(dir, join(dir, "feedback.json"));
  const router = makeRouter({ hosts: {}, store, settings, plugins: null });
  const r = await router.handle(new Request("http://x/api/settings/core.judgment", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ downvoteHides: true }),
  }));
  assertEquals(r.status, 200);
  const ns = await (await router.handle(new Request("http://x/api/settings/core.judgment"))).json();
  assertEquals(ns.downvoteHides, true);
  await rm(dir, { recursive: true });
});
