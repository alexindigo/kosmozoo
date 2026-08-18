// tests/t_hosts.mjs — host management API: env seeds first boot, then
// user-managed via settings; add/remove persist; validation and the
// last-host guard hold.

import { assert, assertEquals } from "jsr:@std/assert";
import { loadHosts, validateHost } from "../src/hosts.mjs";
import { makeRouter } from "../src/routes.mjs";
import { Settings } from "../src/settings.mjs";
import { Store } from "../src/store.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

Deno.test("hosts: env seeds first boot; settings win after that", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-hosts-"));
  const s = await Settings.open(dir);
  const h1 = await loadHosts(s, { KOZMOZOO_HOSTS: "a=1.1.1.1:8188,b=2.2.2.2:8188" });
  assertEquals(h1, { a: "1.1.1.1:8188", b: "2.2.2.2:8188" });
  // a later boot with a DIFFERENT env must not clobber the user-managed map
  const h2 = await loadHosts(s, { KOZMOZOO_HOSTS: "zzz=9.9.9.9:1" });
  assertEquals(Object.keys(h2).sort(), ["a", "b"]);
  await rm(dir, { recursive: true });
});

Deno.test("hosts: validation rejects malformed name/address", () => {
  assert(validateHost("", "x:8188"));
  assert(validateHost("a b", "x:8188"));
  assert(validateHost("ok", "no-port"));
  assert(validateHost("ok", ""));
  assertEquals(validateHost("ms-01", "comfyui.home:8188"), null);
});

Deno.test("hosts: POST adds + persists + probes; DELETE removes; last host guarded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-hosts2-"));
  const settings = await Settings.open(dir);
  const store = await Store.open(dir, join(dir, "feedback.json"));
  const hosts = await loadHosts(settings, { KOZMOZOO_HOSTS: "a=127.0.0.1:1" });
  const router = makeRouter({ hosts, store, settings, plugins: null });

  // add
  const r = await router.handle(new Request("http://x/api/hosts", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "b", address: "127.0.0.1:2" }),
  }));
  assertEquals(r.status, 200);
  const added = await r.json();
  assertEquals(added.online, false); // nothing on port 2, probed
  assert("b" in hosts, "runtime map mutated in place");
  // persisted
  assertEquals(settings.get("core.hosts", "map").b, "127.0.0.1:2");

  // bad input rejected
  const bad = await router.handle(new Request("http://x/api/hosts", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "b ad", address: "x" }),
  }));
  assertEquals(bad.status, 400);

  // remove b, then the guard on the last host
  const d = await router.handle(new Request("http://x/api/hosts/b", { method: "DELETE" }));
  assertEquals(d.status, 200);
  assert(!("b" in hosts));
  const guard = await router.handle(new Request("http://x/api/hosts/a", { method: "DELETE" }));
  assertEquals(guard.status, 400); // last host
  await rm(dir, { recursive: true });
});
