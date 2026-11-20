import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import { Database } from "@db/sqlite";
import { Store } from "../src/store.mjs";
import { buildContext } from "../src/context.mjs";

const NOW = 1795151176167;
const begin = (store, id, now = NOW) => store.variationBegin({
  id, now, format: 1, recipeJson: "{}", targetsJson: "[]", summaryJson: "{}", resources: [],
});

Deno.test("SQLite integers: Store reads exact signed safe integers, effects and leases as JSON numbers", async () => {
  const dir = await Deno.makeTempDir({ prefix: "kz-int64-" });
  let store = await Store.open(dir);
  try {
    for (const [i, value] of [0, 2147483647, 2147483648, -2147483649, NOW, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER].entries()) {
      const id = `integer-${i}`, row = begin(store, id, value);
      assertEquals(row.created_at, value);
      assertEquals(row.updated_at, value);
      assertEquals(JSON.parse(JSON.stringify(row)).created_at, value);
    }
    store.variationPrepareEffect("integer-4", "effect", "target", "{}", "hash");
    store.variationLeaseAcquire("integer-4", "editor", "lease");
    // Direct fixtures exercise stored INTEGERs independently of JS parameter binding.
    const db = new Database(`${dir}/metadata.db`, { int64: true });
    try {
      db.exec(`UPDATE variation_effect SET created_at = ${NOW}, updated_at = ${NOW}`);
      db.exec(`UPDATE variation_lease SET created_at = ${NOW}`);
      assertEquals(db.prepare("SELECT created_at FROM variation_run WHERE id = ?").get("integer-4").created_at, NOW);
    } finally { db.close(); }
    assertEquals(store.variationEffects("integer-4")[0].created_at, NOW);
    assertEquals(store.variationEffects("integer-4")[0].updated_at, NOW);
    assertEquals(store.variationLease("integer-4", "lease").created_at, NOW);
    store.variationOutcome("integer-4", "submitted", "{}", { submitted: 4294967297, total: 4294967298 });
    assertEquals(store.variationGet("integer-4").submitted_count, 4294967297);
    assertEquals(store.variationGet("integer-4").total_count, 4294967298);
    const page = store.variationList(10);
    assertEquals(page.find(row => row.id === "integer-4").created_at, NOW);
    JSON.stringify({ page, effects: store.variationEffects("integer-4"), lease: store.variationLease("integer-4", "lease") });
    store.close(); store = await Store.open(dir);
    assertEquals(store.variationGet("integer-4").created_at, NOW, "existing data needs no migration");
  } finally { store.close(); await Deno.remove(dir, { recursive: true }); }
});

Deno.test("SQLite integers: content joins and TEXT kv counters retain values above 32 bits", async () => {
  const dir = await Deno.makeTempDir({ prefix: "kz-int64-content-" }), store = await Store.open(dir);
  try {
    await store.ingestFile("source", "large.png", "hash", 4294967297, { dims: { width: 2147483648, height: 3 } });
    const db = new Database(`${dir}/metadata.db`, { int64: true });
    try {
      db.exec("UPDATE kv SET v = '4294967297' WHERE k IN ('meta_version', 'variations.history.revision')");
    } finally { db.close(); }
    assertEquals(store.metaVersion, 4294967297);
    assertEquals(store.variationRevision(), 4294967297);
    begin(store, "counter");
    assertEquals(store.variationRevision(), 4294967298);
    assertEquals(store.contentGet("hash").bytes, 4294967297);
    assertEquals(store.entryJoined("source", "large.png").bytes, 4294967297);
    assertEquals(store.entriesForCollection("source")[0].width, 2147483648);
    assertEquals(store.entryDims("source", "large.png"), { width: 2147483648, height: 3 });
    store.entryDimsPut("source", "pending.png", { width: 2147483648, height: 4 });
    assertEquals(store.entryGet("source", "pending.png").width, 2147483648);
    assertEquals(store.dimsForHost("source")["pending.png"], { width: 2147483648, height: 4 });
    JSON.stringify({ content: store.contentGet("hash"), entries: store.entriesForCollection("source"), dims: store.dimsForHost("source") });
  } finally { store.close(); await Deno.remove(dir, { recursive: true }); }
});

Deno.test("SQLite integers: unsafe positive and negative stored integers fail at every row read shape", async () => {
  const dir = await Deno.makeTempDir({ prefix: "kz-int64-unsafe-" }), store = await Store.open(dir);
  try {
    begin(store, "unsafe");
    await store.ingestFile("source", "large.png", "hash", 1);
    const db = new Database(`${dir}/metadata.db`, { int64: true });
    try {
      for (const value of [9007199254740992n, -9007199254740992n]) {
        db.prepare("UPDATE variation_run SET updated_at = ?").run(value);
        db.prepare("UPDATE content SET bytes = ?").run(value);
        assertThrows(() => store.variationGet("unsafe"), RangeError, "safe integer");
        assertThrows(() => store.variationList(10), RangeError, "safe integer");
        assertThrows(() => store.contentGet("hash"), RangeError, "safe integer");
        assertThrows(() => store.entryJoined("source", "large.png"), RangeError, "safe integer");
        assertThrows(() => store.entriesForCollection("source"), RangeError, "safe integer");
      }
    } finally { db.close(); }
  } finally { store.close(); await Deno.remove(dir, { recursive: true }); }
});

Deno.test("SQLite integers: history HTTP list/detail and keyset pages retain millisecond timestamps", async () => {
  const dir = await Deno.makeTempDir({ prefix: "kz-int64-http-" });
  const engine = await buildContext({ env: { HOME: dir, KOZMOZOO_STATE: dir, KOZMOZOO_CACHE: `${dir}/cache`, KOZMOZOO_HOSTS: "" },
    start: false, fakes: { plugins: { list: () => [] } } });
  const call = async path => {
    const response = await engine.router.handle(new Request(`http://localhost/api/features/variations/history${path}`));
    assertEquals(response.status, 200, `${path}: ${response.status}`);
    return response.json();
  };
  try {
    const expected = [];
    for (let i = 0; i < 62; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, at = NOW + Math.floor(i / 3);
      begin(engine.ctx.store, id, at); expected.unshift({ id, at });
    }
    const actual = []; let cursor = null;
    do {
      const page = await call(`?limit=7${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`);
      for (const item of page.items) {
        assert(Number.isSafeInteger(item.createdAt));
        actual.push({ id: item.id, at: item.createdAt });
      }
      cursor = page.nextCursor;
      if (cursor) {
        const decoded = JSON.parse(atob(cursor)), last = actual.at(-1);
        assertEquals(decoded, { at: last.at, id: last.id });
      }
      assert(actual.length <= 62, "pagination must advance without repeating rows");
    } while (cursor);
    assertEquals(actual, expected, "timestamp ties use exact id keysets without gaps or duplicates");
    assertEquals((await call(`/${expected.at(-1).id}`)).createdAt, NOW);
    assertEquals((await call(`/${expected[0].id}`)).createdAt, NOW + 20);
  } finally { await engine.close(); await Deno.remove(dir, { recursive: true }); }
});
