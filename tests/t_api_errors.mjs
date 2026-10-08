import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { ApiError, req } from "../client/js/api.mjs";

Deno.test("shared JSON failures: GET/POST/PATCH carry safe engine detail and stable HTTP context", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = () => Promise.resolve(Response.json({ error: "collection unreachable", reason: "HEAD deadline exceeded" }, { status: 502 }));
    for (const method of ["GET", "POST", "PATCH"]) {
      const error = await assertRejects(() => req(method, "/api/test", method === "GET" ? undefined : {}), ApiError);
      assertEquals([error.method, error.path, error.status], [method, "/api/test", 502]);
      assert(error.message.startsWith(`${method} /api/test: 502`));
      assert(error.message.includes("collection unreachable: HEAD deadline exceeded"));
    }
  } finally { globalThis.fetch = original; }
});

Deno.test("shared JSON failures: empty/malformed/foreign errors remain failed, and successful payloads stay unchanged", async () => {
  const original = globalThis.fetch;
  try {
    for (const body of [null, "<html>upstream failure</html>", "{broken", JSON.stringify({ error: { other: "unknown" } })]) {
      globalThis.fetch = () => Promise.resolve(new Response(body, { status: 503 }));
      const error = await assertRejects(() => req("GET", "/api/test"), ApiError);
      assertEquals(error.message, "GET /api/test: 503");
      assertEquals(error.status, 503);
    }
    globalThis.fetch = () => Promise.resolve(Response.json({ value: [1, 2, 3] }));
    assertEquals(await req("GET", "/api/test"), { value: [1, 2, 3] });
  } finally { globalThis.fetch = original; }
});
