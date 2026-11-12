import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { ContentArchive } from "../src/content-archive.mjs";
import { sha256 } from "../src/cache.mjs";
import { join } from "node:path";
import { Ingest } from "../src/ingest.mjs";
import { mkStateRig } from "./helpers/rig.mjs";
import { Store } from "../src/store.mjs";
import { buildContext } from "../src/context.mjs";

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

Deno.test("history archive recovery: dead request bytes collect at context startup, shared/editor/uncertain bytes and receipts survive", async () => {
  const dir = await Deno.makeTempDir({ prefix: "kz-history-recovery-" }), archive = new ContentArchive(join(dir, "archives"));
  const env = { HOME: dir, KOZMOZOO_STATE: dir, KOZMOZOO_CACHE: join(dir, "cache"), KOZMOZOO_HOSTS: "" };
  let store = await Store.open(dir), engine;
  const rows = [];
  try {
    for (const [index, mode] of ["terminal", "shared-dead", "visible", "editor", "uncertain"].entries()) {
      const id = crypto.randomUUID(), bytes = new Uint8Array(mode.startsWith("shared") || mode === "visible" ? [2] : [index + 10]);
      store.variationBegin({ id, format: 1, recipeJson: "{}", targetsJson: "[]", summaryJson: "{}", resources: [{ id: "image", descriptorJson: "{}" }] });
      const { hash } = await archive.retain(bytes, record => store.variationAttach(id, "image", record));
      store.variationSeal(id, "{}", "a".repeat(64), "{}");
      store.variationPrepareEffect(id, "target", "target", "{}", "request-hash");
      const lease = store.variationClaimExecution(id, "target");
      if (mode !== "uncertain") store.variationEffectResult(id, "target", "confirmed", '{"promptId":"kept"}');
      const editor = crypto.randomUUID(); if (mode === "editor") store.variationLeaseAcquire(id, "editor", editor);
      if (mode !== "visible") store.variationTombstone(id);
      rows.push({ id, mode, bytes, hash, lease, editor });
    }
    store.close(); store = null;
    // Real context construction, no feature-specific recovery/IO or fake upstream.
    engine = await buildContext({ env, start: false, fakes: { plugins: { list: () => [] } } });
    for (const { id, mode, bytes, hash, lease, editor } of rows) {
      assertEquals(engine.ctx.store.variationLease(id, lease), undefined);
      if (mode === "terminal") {
        await assertRejects(() => archive.read(hash), Deno.errors.NotFound);
        assertEquals(engine.ctx.store.variationGet(id).targets_json, null);
        assertEquals(engine.ctx.store.variationEffects(id)[0].request_hash, "request-hash");
      } else assertEquals(await archive.read(hash), bytes);
      if (mode === "shared-dead") assertEquals(engine.ctx.store.variationResources(id), []);
      if (mode === "editor") assertEquals(engine.ctx.store.variationLease(id, editor).kind, "editor");
      if (mode === "uncertain") assertEquals(engine.ctx.store.variationEffects(id)[0].state, "uncertain");
      if (mode === "visible") {
        assertEquals(engine.ctx.store.variationEffects(id)[0].result_json, '{"promptId":"kept"}');
        assertEquals(engine.ctx.store.variationClaimExecution(id, "target"), null, "restart cannot replay a settled effect");
      }
    }
    await engine.close(); engine = await buildContext({ env, start: false, fakes: { plugins: { list: () => [] } } });
    assertEquals(await archive.read(rows[2].hash), rows[2].bytes, "repeated startup retains shared bytes");
  } finally { if (engine) await engine.close(); store?.close(); }
});

Deno.test("history archive recovery: collection failure rejects initialization and leaves durable orphan rows for later retry", async () => {
  const dir = await Deno.makeTempDir({ prefix: "kz-history-collect-retry-" }), archive = new ContentArchive(join(dir, "archives"));
  const env = { HOME: dir, KOZMOZOO_STATE: dir, KOZMOZOO_CACHE: join(dir, "cache"), KOZMOZOO_HOSTS: "" };
  let store = await Store.open(dir);
  const id = crypto.randomUUID(), bytes = new Uint8Array([9, 8, 7]);
  store.variationBegin({ id, format: 1, recipeJson: "{}", targetsJson: "[]", summaryJson: "{}", resources: [{ id: "image", descriptorJson: "{}" }] });
  const { hash } = await archive.retain(bytes, record => store.variationAttach(id, "image", record));
  store.variationPrepareEffect(id, "target", "target", "{}", "hash");
  store.variationClaimExecution(id, "target"); store.variationEffectResult(id, "target", "confirmed", "{}");
  store.variationTombstone(id); store.close();
  let calls = 0;
  class FailingArchive extends ContentArchive { collect() { calls++; throw new Error("fixture collection failure"); } }
  let unexpected;
  try {
    await assertRejects(async () => { unexpected = await buildContext({ env, start: false, fakes: { archive: new FailingArchive(join(dir, "archives")), plugins: { list: () => [] } } }); }, Error, "fixture collection failure");
  } finally { if (unexpected) await unexpected.close(); }
  assertEquals(calls, 1);
  assertEquals(await archive.read(hash), bytes);
  store = await Store.open(dir);
  assertEquals(store.variationResources(id), []);
  assertEquals(store.variationUnreferencedAssets().map(row => row.hash), [hash], "failed collection cannot forget durable retry evidence");
  store.close();
  const engine = await buildContext({ env, start: false, fakes: { plugins: { list: () => [] } } });
  try {
    await assertRejects(() => archive.read(hash), Deno.errors.NotFound);
    assertEquals(engine.ctx.store.variationUnreferencedAssets(), []);
  } finally { await engine.close(); }
});
