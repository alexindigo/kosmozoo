import { assertEquals } from "jsr:@std/assert";
import { makeRouter } from "../src/routes.mjs";
import { register } from "../src/features/variations/server.mjs";
import { sha256 } from "../src/cache.mjs";

Deno.test("all original-media responses isolate documents, including ranges and cache validation", async () => {
  const dir = await Deno.makeTempDir({ prefix: "untrusted-media-" });
  try {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="32"><script>globalThis.pwned=true</script><rect width="48" height="32" fill="red"/></svg>';
    const bytes = new TextEncoder().encode(svg), hash = await sha256(bytes), path = `${dir}/image.svg`;
    await Deno.writeTextFile(path, svg);
    const router = makeRouter({ hosts: { h: `folder:${dir}` }, inventory: {},
      store: { fileInfo: () => ({ hash }) }, cache: { get: () => bytes }, ingest: { scheduleRevalidate() {} } });
    register({ route: (method, path, handler) => router.add(method, "/api/features/variations" + path, handler) });
    for (const url of ["http://engine/api/collections/h/entries/image.svg/bytes", `http://engine/api/content/${hash}/bytes`]) {
      for (const [headers, status] of [[{}, 200], [{ Range: "bytes=0-9" }, 206], [{ "If-None-Match": `"${hash}"` }, 304]]) {
        const response = await router.handle(new Request(url, { headers }));
        assertEquals(response.status, status);
        assertEquals(response.headers.get("Content-Security-Policy"), "sandbox");
        assertEquals(response.headers.get("X-Content-Type-Options"), "nosniff");
        if (status === 200) { assertEquals(response.headers.get("Content-Type"), "image/svg+xml"); assertEquals(await response.text(), svg); }
        else await response.arrayBuffer();
      }
    }
    const folder = await router.handle(new Request("http://engine/api/features/variations/folder-image?path=" + encodeURIComponent(path)));
    assertEquals(folder.status, 200);
    assertEquals(folder.headers.get("Content-Security-Policy"), "sandbox");
    assertEquals(folder.headers.get("X-Content-Type-Options"), "nosniff");
    assertEquals(folder.headers.get("Content-Type"), "image/svg+xml");
    assertEquals(await folder.text(), svg);
  } finally { await Deno.remove(dir, { recursive: true }); }
});
