import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import { Store } from "../src/store.mjs";
import { Database } from "@db/sqlite";

const begin = (store, id = crypto.randomUUID(), now = 100) => {
  store.variationBegin({ id, format: 1, recipeJson: "{}", targetsJson: "[]", summaryJson: "{}", now,
    resources: [{ id: "image-0", descriptorJson: '{"kind":"upload"}' }] });
  return id;
};

Deno.test("history Store: execution claims atomically acquire a unique owner pin", async () => {
  const dir = await Deno.makeTempDir({ prefix: "kz-history-claim-" }), store = await Store.open(dir);
  try {
    const id = begin(store);
    store.variationPrepareEffect(id, "target-0", "target", "{}", "hash");
    const lease = store.variationClaimExecution(id, "target-0");
    assert(lease); assertEquals(store.variationLease(id, lease).kind, "execution");
    assertEquals(store.variationClaimExecution(id, "target-0"), null);
    assert(store.variationLease(id, lease), "losing claims cannot release another request's pin");
    store.variationEffectResult(id, "target-0", "confirmed", "{}");
    store.variationLeaseRelease(id, lease);
    assertEquals(store.variationClaimExecution(id, "target-0"), null);
    store.variationTombstone(id);
    store.variationRetire(id);
    assertEquals(store.variationGet(id).recipe_json, null);
  } finally { store.close(); }
});
Deno.test("history Store: additive retry-safe migration preserves legacy rows and independent metadata cursor", async () => {
  const dir = await Deno.makeTempDir({ prefix: "kz-history-migration-" });
  let store = await Store.open(dir);
  store.collectionAdd("original", "original:8188");
  store.judgmentPatch("original", "a.png", { favorite: true, notes: { pos: "keep" } });
  const kept = store.judgmentGet("original", "a.png"), version = store.metaVersion;
  store.close();
  // Exercise the migration's retry after schema commit but version-write failure.
  const db = new Database(`${dir}/metadata.db`);
  db.exec("PRAGMA user_version = 9"); db.close();
  store = await Store.open(dir);
  const id = begin(store);
  assertEquals(store.judgmentGet("original", "a.png"), kept);
  assertEquals(store.metaVersion, version);
  assertEquals(store.variationList(50).map(row => row.id), [id]);
  assertEquals(store.variationRevision(), 1);
  begin(store, id);
  assertEquals(store.variationRevision(), 1);
  assertThrows(() => store.variationBegin({ id, format: 1, recipeJson: '{"different":true}', targetsJson: "[]", summaryJson: "{}", resources: [] }), Error, "conflict");
  store.close();
});
Deno.test("history Store: sealed snapshots, stable pagination and leases retain deleted draft resources", async () => {
  const dir = await Deno.makeTempDir({ prefix: "kz-history-leases-" });
  const store = await Store.open(dir);
  const id = begin(store), other = begin(store, crypto.randomUUID(), 200), hash = "a".repeat(64);
  store.variationAttach(id, "image-0", { hash, bytes: 3, mime: "image/png" });
  store.variationSeal(id, '{"format":1}', "b".repeat(64), "{}");
  store.variationSeal(id, '{"format":1}', "b".repeat(64), "{}");
  assertThrows(() => store.variationSeal(id, "{}", "c".repeat(64), "{}"), Error, "conflict");
  const first = store.variationList(1);
  assertEquals(first[0].id, other);
  assertEquals(store.variationList(1, { at: first[0].created_at, id: first[0].id })[0].id, id);
  const lease = crypto.randomUUID(); store.variationLeaseAcquire(id, "editor", lease);
  store.variationTombstone(id);
  assertEquals(store.variationList(50).map(row => row.id), [other]);
  assertEquals(store.variationRetire(id), []);
  assertEquals(store.variationResources(id)[0].hash, hash);
  assertThrows(() => store.variationLeaseAcquire(id, "editor", crypto.randomUUID()), Error, "unavailable");
  store.variationLeaseRelease(id, lease);
  assertEquals(store.variationRetire(id), [hash]);
  assertEquals(store.variationResources(id), []);
  assert(store.variationGet(id).deleted_at !== null);
  store.close();
});
Deno.test("history Store: durable claims never replay and restart marks unfinished effects uncertain", async () => {
  const dir = await Deno.makeTempDir({ prefix: "kz-history-effects-" });
  let store = await Store.open(dir), id = begin(store);
  store.variationPrepareEffect(id, "job-0", "permutation", "{}", "d".repeat(64));
  assertEquals(store.variationClaimEffect(id, "job-0"), true);
  assertEquals(store.variationClaimEffect(id, "job-0"), false);
  assertThrows(() => store.variationPrepareEffect(id, "job-0", "permutation", '{"changed":1}', "e".repeat(64)), Error, "conflict");
  store.close(); store = await Store.open(dir);
  assertEquals(store.variationEffects(id)[0].state, "uncertain");
  assertEquals(store.variationClaimEffect(id, "job-0"), false);
  assertEquals(store.variationGet(id).capture_state, "interrupted");
  assertEquals(store.variationGet(id).outcome, "uncertain");
  store.close();
});
