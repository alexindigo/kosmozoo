import { assertEquals } from "jsr:@std/assert";
import { fakeComfyInline } from "./helpers/fake-comfy-inline.mjs";

Deno.test("inline fake: all roots resolve nested names and honor partial reads", async () => {
  const bytes = new TextEncoder().encode("0123456789");
  const roots = Object.fromEntries(["input", "output", "temp"].map(type =>
    [type, { "nested/leaf.png": { bytes, etag: '"nested"' } }]));
  const fake = fakeComfyInline({ roots });
  try {
    for (const type of ["input", "output", "temp"]) {
      const url = `http://${fake.addr}/api/view?type=${type}&filename=leaf.png&subfolder=nested`;
      const head = await fetch(url, { method: "HEAD" });
      assertEquals([head.status, head.headers.get("content-length")], [200, "10"]);
      const partial = await fetch(url, { headers: { Range: "bytes=2-5" } });
      assertEquals([partial.status, partial.headers.get("content-range"), partial.headers.get("content-length"), await partial.text()],
        [206, "bytes 2-5/10", "4", "2345"]);
      const full = await fetch(url);
      assertEquals(await full.text(), "0123456789");
    }
    assertEquals(fake.state.reads, ["input:nested/leaf.png", "output:nested/leaf.png", "temp:nested/leaf.png"]);
  } finally { await fake.close(); }
});
