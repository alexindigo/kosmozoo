import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert";
import { Cache, sha256 } from "../src/cache.mjs";
import { makeRouter } from "../src/routes.mjs";

Deno.test("cache digest boundary rejects path syntax before reads and writes", async () => {
  const dir = await Deno.makeTempDir({ prefix: "digest-boundary-" });
  try {
    const cache = new Cache(`${dir}/cache`);
    await Deno.writeTextFile(`${dir}/secret`, "outside cache");
    const bytes = new TextEncoder().encode("cached bytes"), hash = await sha256(bytes);
    await cache.put(hash, bytes);
    assertEquals(new Uint8Array(await cache.get(hash)), bytes);
    for (const invalid of ["../../secret", "../secret", "/secret", "ab/../secret", "a\\b", "a".repeat(63), "a".repeat(65), "g".repeat(64), hash.toUpperCase(), "", null, 123]) {
      assertThrows(() => cache.path(invalid), TypeError, "SHA-256");
      await assertRejects(() => cache.get(invalid), TypeError, "SHA-256");
      await assertRejects(() => cache.put(invalid, bytes), TypeError, "SHA-256");
      assertEquals(await cache.has(invalid), false);
    }
    assertEquals(await Deno.readTextFile(`${dir}/secret`), "outside cache");
  } finally { await Deno.remove(dir, { recursive: true }); }
});

Deno.test("content routes reject decoded non-digests before touching cache or store", async () => {
  const touched = [];
  const router = makeRouter({ cache: { get: () => { touched.push("cache"); return new Uint8Array([1]); } },
    store: { contentGet: () => { touched.push("store"); return {}; }, instancesOf: () => [] } });
  for (const hash of ["..%2F..%2Fsecret", "ab%5Csecret", "not-a-hash", "a".repeat(65)]) {
    for (const suffix of ["", "/bytes"]) {
      const response = await router.handle(new Request(`http://engine/api/content/${hash}${suffix}`));
      assertEquals(response.status, 400);
      await response.arrayBuffer();
    }
  }
  assertEquals(touched, []);
});
