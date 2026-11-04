import { assertEquals } from "jsr:@std/assert";
import { makeRouter } from "../src/routes.mjs";
import { Settings } from "../src/settings.mjs";
import { register } from "../src/features/variations/server.mjs";

Deno.test("shared mutation admission rejects foreign browser requests before every core, feature and plugin handler", async () => {
  let effects = 0;
  const router = makeRouter({});
  for (const method of ["POST", "PATCH", "DELETE", "PUT"]) {
    router.add(method, `/api/test/${method}`, () => { effects++; return Response.json({ ok: true }); });
    for (const headers of [{ Origin: "https://foreign.invalid" }, { Origin: "null" }, { Origin: "http://engine.evil" },
      { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" }, { Origin: "http://engine", "Sec-Fetch-Site": "cross-site" }]) {
      const response = await router.handle(new Request(`http://engine/api/test/${method}`, {
        method, headers: { "Content-Type": "application/json", ...headers }, body: "{}",
      }));
      assertEquals(response.status, 403); await response.arrayBuffer();
    }
  }
  for (const path of ["/api/collections", "/api/prefetch", "/api/collections/h/entries", "/api/features/variations/choose-folder", "/api/plugins/example/write"]) {
    router.add("POST", path, () => { effects++; return Response.json({ ok: true }); });
    const response = await router.handle(new Request("http://engine" + path, { method: "POST", headers: { Origin: "https://foreign.invalid" }, body: "{}" }));
    assertEquals(response.status, 403); await response.arrayBuffer();
  }
  assertEquals(effects, 0);
});

Deno.test("mutation content admission rejects browser-simple JSON, preserves same-origin and non-browser JSON and explicit uploads", async () => {
  const dir = await Deno.makeTempDir({ prefix: "csrf-settings-" });
  try {
    const settings = await Settings.open(dir), router = makeRouter({ settings });
    for (const type of [undefined, "text/plain", "application/x-www-form-urlencoded", "text/html", "image/svg+xml"]) {
      const response = await router.handle(new Request("http://engine/api/settings/core.test", { method: "PATCH", body: '{"value":"bad"}',
        headers: type ? { "Content-Type": type } : {} }));
      assertEquals(response.status, 415); await response.arrayBuffer();
    }
    assertEquals(settings.getNs("core.test"), {});
    for (const metadata of [{}, { Origin: "http://engine", "Sec-Fetch-Site": "same-origin" }, { "Sec-Fetch-Site": "none" }]) {
      const response = await router.handle(new Request("http://engine/api/settings/core.test", { method: "PATCH", body: '{"value":"saved"}',
        headers: { "Content-Type": "application/json; charset=utf-8", ...metadata } }));
      assertEquals(response.status, 200); assertEquals(await response.json(), { value: "saved" });
    }
    assertEquals((await Settings.open(dir)).get("core.test", "value"), "saved");
    for (const type of ["multipart/form-data; boundary=test", "application/octet-stream"]) {
      const response = await router.handle(new Request("http://engine/api/settings/core.test", { method: "PATCH", headers: { "Content-Type": type }, body: '{"value":"bad"}' }));
      assertEquals(response.status >= 400 && response.status < 500, true); await response.arrayBuffer();
    }
    let uploads = 0;
    router.add("POST", "/api/plugins/example/binary", () => { uploads++; return new Response(null, { status: 204 }); });
    for (const type of ["multipart/form-data; boundary=test", "application/octet-stream"]) {
      const response = await router.handle(new Request("http://engine/api/plugins/example/binary", { method: "POST", headers: { "Content-Type": type, Origin: "http://engine" }, body: "bytes" }));
      assertEquals(response.status, 204);
    }
    assertEquals(uploads, 2);
    assertEquals(settings.get("core.test", "value"), "saved");
  } finally { await Deno.remove(dir, { recursive: true }); }
});

Deno.test("desktop chooser uses shared mutation admission without blocking same-origin app requests", async () => {
  let chosen = 0;
  const router = makeRouter({});
  register({ route: (method, path, handler) => router.add(method, "/api/features/variations" + path, handler),
    desktop: { choose: ({ path }) => { chosen++; return { path, cancelled: false }; } } });
  const path = "http://localhost:19160/api/features/variations/choose-folder";
  const denied = await router.handle(new Request(path, { method: "POST", headers: { Origin: "https://foreign.invalid", "Content-Type": "application/json" }, body: '{"path":"/images"}' }));
  assertEquals(denied.status, 403); await denied.arrayBuffer(); assertEquals(chosen, 0);
  const allowed = await router.handle(new Request(path, { method: "POST", headers: { Origin: "http://localhost:19160", "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" }, body: '{"path":"/images"}' }));
  assertEquals(allowed.status, 200); assertEquals(await allowed.json(), { path: "/images", cancelled: false }); assertEquals(chosen, 1);
});

Deno.test("real HTTP bodyless mutations need no content type, even when the server exposes an empty stream", async () => {
  const router = makeRouter({});
  for (const method of ["DELETE", "POST"]) router.add(method, "/api/empty", () => new Response(null, { status: 204 }));
  const observed = [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, req => {
    observed.push({ method: req.method, headers: [...req.headers], bodyStream: req.body !== null });
    return router.handle(req);
  });
  try {
    for (const method of ["DELETE", "POST"]) {
      const response = await fetch(`http://127.0.0.1:${server.addr.port}/api/empty`, { method });
      const detail = await response.text();
      assertEquals(response.status, 204, `${method}: ${detail}; ${JSON.stringify(observed)}`);
    }
  } finally { await server.shutdown(); }
});
