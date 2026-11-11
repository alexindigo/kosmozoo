import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { ContentArchive } from "../src/content-archive.mjs";
import { sha256 } from "../src/cache.mjs";
import { join } from "node:path";
import { Ingest } from "../src/ingest.mjs";
import { mkStateRig } from "./helpers/rig.mjs";

Deno.test("history archive: bytes precede reference publication, shared retention serializes collection", async () => {
  const dir = await Deno.makeTempDir({ prefix: "kz-history-archive-" });
  const archive = new ContentArchive(join(dir, "archives")), bytes = new Uint8Array([1, 2, 3]);
  let refs = 0;
  const record = await archive.retain(bytes, async r => {
    assertEquals(await Deno.readFile(join(dir, "archives", r.hash.slice(0, 2), r.hash)), bytes);
    refs++;
  });
  await archive.retain(bytes, () => refs++);
  assertEquals(await archive.collect(record.hash, () => refs > 0, () => {}), false);
  assertEquals(await archive.read(record.hash), bytes);
  refs = 0;
  assertEquals(await archive.collect(record.hash, () => refs > 0, () => {}), true);
  await assertRejects(() => archive.read(record.hash), Deno.errors.NotFound);
});
Deno.test("history archive: invalid keys, symlink paths, corrupted bytes and failed writes publish no references", async () => {
  const dir = await Deno.makeTempDir({ prefix: "kz-history-corrupt-" });
  const archive = new ContentArchive(join(dir, "archives")), bytes = new Uint8Array([4, 5]), hash = await sha256(bytes);
  let published = false;
  await assertRejects(() => archive.read("../outside"), TypeError);
  await Deno.mkdir(join(dir, "archives"));
  await Deno.symlink(dir, join(dir, "archives", hash.slice(0, 2)));
  await assertRejects(() => archive.retain(bytes, () => { published = true; }), Error, "directory");
  assertEquals(published, false);
  const safe = new ContentArchive(join(dir, "safe"));
  await safe.retain(bytes, () => {});
  await Deno.writeFile(join(dir, "safe", hash.slice(0, 2), hash), new Uint8Array([9]));
  await assertRejects(() => safe.read(hash), Error, "corrupt");
  await assertRejects(() => safe.retain(bytes, () => { published = true; }), Error, "corrupt");
  assert(!published);
});

Deno.test("history archive: rejected publication rolls back only unreferenced new objects", async () => {
  const dir = await Deno.makeTempDir({ prefix: "kz-history-rollback-" }), archive = new ContentArchive(dir);
  const bytes = new Uint8Array([12, 34]), hash = await sha256(bytes); let refs = 0, forgotten = 0;
  const ownership = { hasReferences: () => refs > 0, forget: () => forgotten++ };
  await assertRejects(() => archive.retain(bytes, () => { throw new Error("publication failed"); }, ownership), Error, "publication failed");
  await assertRejects(() => archive.read(hash), Deno.errors.NotFound);
  assertEquals(forgotten, 1);
  await archive.retain(bytes, () => refs++, ownership);
  await assertRejects(() => archive.retain(bytes, () => { throw new Error("conflict"); }, ownership));
  assertEquals(await archive.read(hash), bytes); assertEquals(forgotten, 1);
  const partiallyPublished = new Uint8Array([56, 78]), partialHash = await sha256(partiallyPublished);
  await assertRejects(() => archive.retain(partiallyPublished, () => { refs++; throw new Error("after membership"); }, ownership));
  assertEquals(await archive.read(partialHash), partiallyPublished, "rollback must consult references even for a newly created object");
});

Deno.test("history fresh-source proof: cache hits never discharge freshness and all fresh reads share the existing gate", async () => {
  const rig = await mkStateRig("history-fresh", {});
  let value = "old", active = 0, maximum = 0, reads = 0, missing = false;
  const backing = {
    async read() {
      reads++; active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 2)); active--;
      return { status: missing ? 404 : 200, body: new TextEncoder().encode(value) };
    }, stat: () => ({ stamp: "same-stamp" }),
  };
  const ingest = new Ingest(rig.store, { fake: "fake:8188" }, { cache: rig.cache, backingFor: () => backing });
  try {
    const initial = await ingest.ensure("fake", "saved.png", "input");
    value = "changed";
    const [cached, fresh] = await Promise.all([
      ingest.ensure("fake", "saved.png", "input"),
      ingest.ensure("fake", "saved.png", "input", { fresh: true, priority: "high" }),
    ]);
    assertEquals(cached.hash, initial.hash); assert(fresh.hash !== initial.hash);
    assertEquals(reads, 2);
    await Promise.all(Array.from({ length: 12 }, (_, i) => ingest.ensure("fake", `fresh-${i}.png`, "input", { fresh: true, priority: "high" })));
    assert(maximum <= 4);
    missing = true;
    assertEquals((await ingest.ensure("fake", "saved.png", "input", { fresh: true })).status, 404);
    assertEquals((await ingest.ensure("fake", "saved.png", "input")).hash, fresh.hash);
  } finally { await rig.close(); }
});
