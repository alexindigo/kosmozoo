// tests/t_hosts.mjs — host management API: env seeds first boot, then
// user-managed via settings; add/remove persist; validation and the
// last-host guard hold.

import { assert, assertEquals } from "jsr:@std/assert";
import { loadCollections, validateCollection } from "../src/collections.mjs";
import { backingFor } from "../src/backings/index.mjs";
import { comfyClient } from "../src/backings/comfy.mjs";
import { makeRouter } from "../src/routes.mjs";
import { Settings } from "../src/settings.mjs";
import { Store } from "../src/store.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Minimal fake ComfyUI on an ephemeral port (the t_revalidate pattern).
function fakeComfy(handler) {
  const srv = Deno.serve({ port: 0, hostname: "127.0.0.1" }, handler);
  return { addr: `127.0.0.1:${srv.addr.port}`, close: () => srv.shutdown() };
}

Deno.test("hosts: env seeds first boot; collections win after that", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-hosts-"));
  const settings = await Settings.open(dir);
  const store = await Store.open(dir, join(dir, "feedback.json"), { settings });
  const h1 = await loadCollections(store, { KOZMOZOO_HOSTS: "a=1.1.1.1:8188,b=2.2.2.2:8188" });
  assertEquals(h1, { a: "1.1.1.1:8188", b: "2.2.2.2:8188" });
  // a later boot with a DIFFERENT env must not clobber the user-managed map
  const h2 = await loadCollections(store, { KOZMOZOO_HOSTS: "zzz=9.9.9.9:1" });
  assertEquals(Object.keys(h2).sort(), ["a", "b"]);
  // and the collection table (not a settings namespace) carries them
  assertEquals(store.collectionGet("b").address, "2.2.2.2:8188");
  assertEquals(settings.get("core.hosts", "map", null), null);
  await rm(dir, { recursive: true });
});

Deno.test("hosts: validation rejects malformed name/address", async () => {
  assert(await validateCollection("", "x:8188"));
  assert(await validateCollection("a b", "x:8188"));
  assert(await validateCollection("ok", "no-port"));
  assert(await validateCollection("ok", ""));
  assertEquals(await validateCollection("ms-01", "comfyui.home:8188"), null);
});

Deno.test("hosts: POST adds + persists + probes; DELETE removes; last host guarded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-hosts2-"));
  const settings = await Settings.open(dir);
  const store = await Store.open(dir, join(dir, "feedback.json"), { settings });
  const hosts = await loadCollections(store, { KOZMOZOO_HOSTS: "a=127.0.0.1:1" });
  const router = makeRouter({ hosts, store, settings, plugins: null });

  // add
  const r = await router.handle(new Request("http://x/api/collections", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "b", address: "127.0.0.1:2" }),
  }));
  assertEquals(r.status, 200);
  const added = await r.json();
  assertEquals(added.online, false); // nothing on port 2, probed
  assert("b" in hosts, "runtime map mutated in place");
  // persisted (to the collection table)
  assertEquals(store.collectionGet("b").address, "127.0.0.1:2");

  // bad input rejected
  const bad = await router.handle(new Request("http://x/api/collections", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "b ad", address: "x" }),
  }));
  assertEquals(bad.status, 400);

  // remove b, then the guard on the last host
  const d = await router.handle(new Request("http://x/api/collections/b", { method: "DELETE" }));
  assertEquals(d.status, 200);
  assert(!("b" in hosts));
  const guard = await router.handle(new Request("http://x/api/collections/a", { method: "DELETE" }));
  assertEquals(guard.status, 400); // last host
  await rm(dir, { recursive: true });
});

Deno.test("hosts: upload never sends overwrite; 409 surfaces the conflicting name", async () => {
  let sawOverwrite = "unset";
  const { addr, close } = fakeComfy(async (req) => {
    if (new URL(req.url).pathname === "/api/upload/image") {
      const form = await req.formData();
      sawOverwrite = form.get("overwrite");
      const name = form.get("image")?.name;
      if (name === "taken.png") return new Response("exists", { status: 409 });
      return Response.json({ name });
    }
    return new Response("nf", { status: 404 });
  });
  try {
    // the host function passes the 409 through, without an overwrite flag
    const r = await backingFor(addr).write(addr, "taken.png", new Uint8Array([1]));
    assertEquals(r.ok, false);
    assertEquals(r.status, 409);
    assertEquals(sawOverwrite, null);

    // the route answers 409 carrying the conflicting name
    const dir = await mkdtemp(join(tmpdir(), "kz-upload-"));
    const settings = await Settings.open(dir);
    const store = await Store.open(dir, join(dir, "feedback.json"));
    const router = makeRouter({ hosts: { c: addr }, store, settings, plugins: null });
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array([1])], { type: "image/png" }), "taken.png");
    const res = await router.handle(new Request("http://x/api/collections/c/entries", { method: "POST", body: form }));
    assertEquals(res.status, 409);
    assertEquals((await res.json()).name, "taken.png");

    // a free name still uploads fine
    const ok = await backingFor(addr).write(addr, "free.png", new Uint8Array([2]));
    assertEquals(ok, { ok: true, name: "free.png" });
    await rm(dir, { recursive: true });
  } finally {
    await close();
  }
});

Deno.test("hosts: assets-plus probe caches only definitive answers", async () => {
  let probeCalls = 0;
  let mode = "500";
  const { addr, close } = fakeComfy((req) => {
    if (new URL(req.url).pathname === "/api/assets_plus/output/delete") {
      probeCalls++;
      if (mode === "ok") return Response.json({ removed: [], failed: [] });
      return new Response("no", { status: mode === "500" ? 500 : 404 });
    }
    return new Response("nf", { status: 404 });
  });
  try {
    // the caches live on the client instance (one per address, built by the
    // context) — not in module globals
    const client = comfyClient(addr);
    // non-definitive answers (500) are NOT cached: every call re-probes
    assertEquals(await client.hasAssetsPlus(), false);
    assertEquals(probeCalls, 1);
    assertEquals(await client.hasAssetsPlus(), false);
    assertEquals(probeCalls, 2);

    // a definitive 404 (no extension) IS cached within the TTL
    mode = "404";
    assertEquals(await client.hasAssetsPlus(), false);
    assertEquals(probeCalls, 3);
    assertEquals(await client.hasAssetsPlus(), false);
    assertEquals(probeCalls, 3);

    // a real probe (200 with the delete-shaped body) is definitive: cached
    // (fresh client — the cache is per address / per client instance)
    let probeCalls2 = 0;
    const { addr: addr2, close: close2 } = fakeComfy((req) => {
      if (new URL(req.url).pathname === "/api/assets_plus/output/delete") {
        probeCalls2++;
        return Response.json({ removed: [], failed: [] });
      }
      return new Response("nf", { status: 404 });
    });
    try {
      const client2 = comfyClient(addr2);
      assertEquals(await client2.hasAssetsPlus(), true);
      assertEquals(await client2.hasAssetsPlus(), true);
      assertEquals(probeCalls2, 1);
    } finally {
      await close2();
    }
  } finally {
    await close();
  }
});
