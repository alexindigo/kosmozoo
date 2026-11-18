import { assert, assertEquals } from "jsr:@std/assert";
import { Database } from "@db/sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.mjs";
import { makeCollectionLifecycle, makeCollectionInventory } from "../src/backings/index.mjs";
import { Prefetch } from "../src/prefetch.mjs";
import { Ingest } from "../src/ingest.mjs";
import { sourceOrigin, sameOrigin, validOrigin, validContext, sameContext } from "../src/source-origin.mjs";
import { staleSource, sourceFailure } from "../client-solid/features/variations/source-message.js";
import { testPng } from "./helpers/png.mjs";

const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
async function stateFixture(run) {
  const dir = await Deno.makeTempDir({ dir: tmpdir(), prefix: "kz-source-identity-" });
  let success = false;
  try { await run(dir); success = true; }
  finally {
    if (success) await Deno.remove(dir, { recursive: true });
    else console.error(`Source identity failure evidence retained: ${dir}`);
  }
}

for (const partial of ["absent", "null", "assigned"]) Deno.test(`source identity: v10 upgrade ${partial} backfills once and preserves records`, () => stateFixture(async dir => {
  const original = await Store.open(dir);
  original.collectionAdd("a", "a:1", { pinned: true }); original.collectionAdd("b", "b:1");
  original.judgmentPatch("a", "kept.png", { favorite: true });
  const kept = original.collectionIncarnation("a"); original.close();
  const db = new Database(join(dir, "metadata.db"));
  try {
    if (partial === "absent") db.exec("ALTER TABLE collection DROP COLUMN incarnation");
    else db.exec(`UPDATE collection SET incarnation = NULL ${partial === "assigned" ? "WHERE id = 'b'" : ""}`);
    db.exec("PRAGMA user_version = 10");
  } finally { db.close(); }
  let expected;
  for (let attempt = 0; attempt < 2; attempt++) {
    const store = await Store.open(dir);
    try {
      const rows = store.collections();
      assert(rows.every(row => uuid(row.incarnation))); assert(rows[0].incarnation !== rows[1].incarnation);
      if (partial === "assigned") assertEquals(store.collectionIncarnation("a"), kept);
      if (expected) assertEquals(rows, expected); else expected = rows;
      assertEquals(store.collectionGet("a").pinned, 1);
      assertEquals(store.judgmentGet("a", "kept.png"), { favorite: true });
    } finally { store.close(); }
  }
}));

Deno.test("source identity: inserts, placeholders, attributes and remove/re-add own durable incarnations", () => stateFixture(async dir => {
  let store = await Store.open(dir);
  store.collectionAdd("a", "a:1"); const first = store.collectionIncarnation("a");
  store.collectionAdd("a", "different:1"); store.collectionPatch("a", { pinned: true, autoRefresh: true });
  assertEquals(store.collectionIncarnation("a"), first); assertEquals(store.collectionGet("a").address, "a:1");
  store.judgmentPatch("placeholder", "kept.png", { bookmark: true });
  const placeholder = store.collectionIncarnation("placeholder"); assert(uuid(placeholder));
  assertEquals(store.collectionGet("placeholder").address, null); assertEquals(store.collectionIncarnation("missing"), null);
  store.close(); store = await Store.open(dir);
  try {
    assertEquals(store.collectionIncarnation("a"), first); assertEquals(store.collectionIncarnation("placeholder"), placeholder);
    store.collectionRemove("a"); store.collectionAdd("a", "a:1");
    assert(uuid(store.collectionIncarnation("a"))); assert(store.collectionIncarnation("a") !== first);
    const second = store.collectionIncarnation("a");
    store.collectionRemove("a"); store.collectionAdd("a", "folder:/images");
    assert(store.collectionIncarnation("a") !== second); assertEquals(store.collectionGet("a").kind, "folder");
  } finally { store.close(); }
}));

Deno.test("source identity: inventory, prefetch and ingest use the registration while tokens stay lifetime-owned", () => stateFixture(async dir => {
  const store = await Store.open(dir), hosts = { a: "a:1" };
  store.collectionAdd("a", hosts.a);
  const options = { incarnationOf: id => store.collectionIncarnation(id) };
  const inventory = makeCollectionInventory(hosts, options), other = makeCollectionLifecycle(hosts, undefined, options);
  const prefetch = new Prefetch({ store, hosts, settings: {}, ingest: {} });
  const bytes = testPng(2, 3), originalIncarnation = store.collectionIncarnation("a");
  // Ingest's ordinary pending read must fence a same-address replacement, too.
  let release, started;
  const admitted = new Promise(resolve => { started = resolve; });
  const backing = { read: async () => { started(); await new Promise(resolve => { release = resolve; }); return bytes; }, stat: async () => ({ stamp: "s" }) };
  const ingest = new Ingest(store, hosts, { cache: { get: async () => null, put: async () => {} }, backingFor: () => backing });
  try {
    assertEquals(inventory.capture("a").incarnation, originalIncarnation);
    assertEquals(prefetch.capture("a").incarnation, originalIncarnation);
    assertEquals(other.capture("a").incarnation, originalIncarnation);
    assert(!inventory.isCurrent(other.capture("a")), "durable values never grant another engine's token currency");
    const token = inventory.capture("a"), pending = ingest.ensure("a", "new.png");
    await admitted;
    store.collectionRemove("a"); store.collectionAdd("a", hosts.a);
    release(); const result = await pending;
    assertEquals(result.status, 499); assertEquals(store.hashFor("a", "new.png"), null);
    assert(!inventory.isCurrent(token)); assert(inventory.capture("a").incarnation !== originalIncarnation);
    assertEquals(prefetch.capture("a").incarnation, store.collectionIncarnation("a"));
    const unknown = other.capture("unknown"); assert(uuid(unknown.incarnation)); assert(other.isCurrent(unknown));
  } finally { release?.(); await inventory.stop(); await prefetch.stop(); other.stop(); store.close(); }
}));

Deno.test("source identity: origins ignore stream epochs, reject old shapes and retain exact graph/registration fencing", () => {
  const record = { address: "a:1", kind: "comfy", incarnation: "registration", sourceVersion: { epoch: "before", incarnation: "registration" } };
  const before = sourceOrigin("a", record), context = { origin: before, graphHash: "a".repeat(64) };
  record.sourceVersion.epoch = "after";
  assertEquals(Object.keys(before), ["source", "address", "kind", "incarnation"]);
  assert(sameOrigin(before, sourceOrigin("a", record))); assert(validContext(context));
  assert(sameContext(context, { ...context, origin: sourceOrigin("a", record) }));
  assert(!sameContext(context, { ...context, graphHash: "b".repeat(64) }));
  const legacy = { ...before, epoch: "before" };
  assert(!validOrigin(legacy)); assert(!sameOrigin(legacy, before)); assert(!validContext({ ...context, origin: legacy }));
  for (const change of [{ source: "alias" }, { address: "b:1" }, { kind: "folder" }, { incarnation: "replacement" }]) assert(!sameOrigin(before, { ...before, ...change }));
  record.sourceVersion.incarnation = "mismatch"; assertEquals(sourceOrigin("a", record), null);
  assertEquals(sourceFailure(412, "Source origin changed before upload", "a"), staleSource("a"));
  assertEquals(sourceFailure(412, "Run destination changed; work was kept", "destination"), staleSource("destination"));
  assertEquals(sourceFailure(500, "offline", "a"), "offline"); assert(!staleSource("a").includes("\n"));
});

Deno.test("source identity: a member created before its row is not retired when the row appears", () => stateFixture(async dir => {
  const store = await Store.open(dir), hosts = { c: "example:1" };
  const lifecycle = makeCollectionLifecycle(hosts, undefined, { incarnationOf: id => store.collectionIncarnation(id) });
  try {
    const token = lifecycle.capture("c");
    assert(uuid(token.incarnation)); assertEquals(store.collectionIncarnation("c"), null);
    store.judgmentPatch("c", "late.png", { bookmark: true });
    assert(uuid(store.collectionIncarnation("c")));
    assert(lifecycle.isCurrent(token), "a first row is not a replacement");
  } finally { lifecycle.stop(); store.close(); }
}));

Deno.test("source identity: incarnation reads never touch SQL, so late checks after close stay safe", () => stateFixture(async dir => {
  const store = await Store.open(dir);
  store.collectionAdd("a", "a:1");
  const incarnation = store.collectionIncarnation("a");
  store.close();
  assertEquals(store.collectionIncarnation("a"), incarnation);
  assertEquals(store.collectionIncarnation("missing"), null);
}));

Deno.test("source identity: a stored incarnation names one registration at one address", () => stateFixture(async dir => {
  const store = await Store.open(dir), hosts = { a: "a:1" };
  store.collectionAdd("a", hosts.a);
  const lifecycle = makeCollectionLifecycle(hosts, undefined, { incarnationOf: (id, address) => store.collectionIncarnation(id, address) });
  try {
    const token = lifecycle.capture("a");
    assertEquals(token.incarnation, store.collectionIncarnation("a"));
    hosts.a = "b:1";
    assert(!lifecycle.isCurrent(token));
    const moved = lifecycle.capture("a");
    assert(moved.incarnation !== token.incarnation, "a live address the row does not describe gets its own identity");
    assertEquals(store.collectionIncarnation("a", "b:1"), null);
  } finally { lifecycle.stop(); store.close(); }
}));

Deno.test("source identity: a source added by an older engine gets a stored identity at the next start", () => stateFixture(async dir => {
  let store = await Store.open(dir);
  store.collectionAdd("a", "a:1");
  const kept = store.collectionIncarnation("a");
  store.close();
  // 0.4.x opens a schema-11 database and inserts rows without an incarnation.
  const raw = new Database(join(dir, "metadata.db"));
  try { raw.prepare("INSERT INTO collection (id, kind, address, created_at) VALUES (?, 'comfy', ?, ?)").run("old", "old:1", Date.now()); }
  finally { raw.close(); }
  store = await Store.open(dir);
  let assigned;
  try {
    assigned = store.collectionIncarnation("old");
    assert(uuid(assigned), "a missing identity is assigned on open");
    assertEquals(store.collectionGet("old").incarnation, assigned, "and stored, not only cached");
    assertEquals(store.collectionIncarnation("a"), kept, "existing identities never change");
  } finally { store.close(); }
  store = await Store.open(dir);
  try { assertEquals(store.collectionIncarnation("old"), assigned, "stable after another start"); }
  finally { store.close(); }
}));
