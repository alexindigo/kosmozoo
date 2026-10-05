// tests/t_judgment.mjs — the judgment model: vote/favorite/hidden are
// distinct; down-vote-hides coupling is a setting; reveal is temporary and
// non-destructive. Judgments are entry columns (sqlite canonical);
// judgmentPatch whitelists fields and deep-prunes defaults; two entries
// sharing one hash carry INDEPENDENT judgments.

import { assert, assertEquals } from "jsr:@std/assert";
import { Store } from "../src/store.mjs";
import { makeRouter } from "../src/routes.mjs";
import { Database } from "@db/sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- judgment semantics (pure functions on plain objects — no DOM) ---------

function isVisible(judgment, { downvoteHides = true, reveal = false } = {}) {
  const down = judgment?.vote === "down";
  if (!down) return true;
  if (!downvoteHides) return true;
  return reveal;
}

Deno.test("judgment: vote/favorite/hidden are distinct concepts", () => {
  const j = { vote: "down", favorite: true };
  assertEquals(j.vote, "down");
  assertEquals(j.favorite, true);
});

Deno.test("judgment: down-vote hides by default; coupling is a setting", () => {
  const j = { vote: "down" };
  assertEquals(isVisible(j), false);
  assertEquals(isVisible(j, { downvoteHides: false }), true);
});

Deno.test("judgment: 'show thumbed-down' is a temporary reveal, not a deletion", () => {
  const j = { vote: "down" };
  assertEquals(isVisible(j, { reveal: true }), true);
  assertEquals(j.vote, "down");
});

// --- entry columns ------------------------------------------------------------

Deno.test("judgment: patch whitelists fields and deep-prunes defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-jpatch-"));
  const store = await Store.open(dir);

  // unknown fields rejected (E6)
  assertEquals(store.judgmentPatch("h", "a.png", { ref: "x", plugins: {} }).ok, false);
  assertEquals(store.judgmentPatch("h", "a.png", { "plugins..x": 1 }).ok, false);

  // write → read back; defaults prune
  store.judgmentPatch("h", "a.png", { vote: "down", favorite: true, notes: { pos: "c", neg: "" } });
  assertEquals(store.judgmentGet("h", "a.png"), { vote: "down", favorite: true, notes: { pos: "c" } });

  // plugin fields namespaced and pruned with the rest
  store.judgmentPatch("h", "a.png", { "plugins.export.bucket": "good" });
  assertEquals(store.judgmentGet("h", "a.png").plugins, { export: { bucket: "good" } });
  store.judgmentPatch("h", "a.png", { "plugins.export.bucket": null });
  assertEquals(store.judgmentGet("h", "a.png").plugins, undefined);

  // clearing everything prunes the row back to empty
  store.judgmentPatch("h", "a.png", { vote: null, favorite: null, notes: null });
  assertEquals(store.judgmentGet("h", "a.png"), null);

  store.close();
  await rm(dir, { recursive: true });
});

Deno.test("judgment: two entries sharing one hash carry independent judgments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-jper-"));
  const store = await Store.open(dir);
  const h = "ab".repeat(32);
  await store.ingestFile("a", "same.png", h, 10);
  await store.ingestFile("b", "same.png", h, 10);

  store.judgmentPatch("a", "same.png", { vote: "up" });
  store.judgmentPatch("b", "same.png", { vote: "down", notes: { neg: "dupe" } });

  assertEquals(store.judgmentGet("a", "same.png"), { vote: "up" });
  assertEquals(store.judgmentGet("b", "same.png"), { vote: "down", notes: { neg: "dupe" } });

  store.close();
  await rm(dir, { recursive: true });
});

Deno.test("judgment: bookmark and favorite toggle independently without changing other fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-jbookmark-"));
  const store = await Store.open(dir);
  try {
    const other = { vote: "down", notes: { pos: "keep" }, plugins: { det: { faces: 2 } } };
    store.judgmentPatch("h", "a.png", { vote: other.vote, notes: other.notes, "plugins.det.faces": 2, favorite: true });
    assertEquals(store.judgmentGet("h", "a.png"), { ...other, favorite: true });
    assertEquals(store.judgmentPatch("h", "a.png", { bookmark: true }), {
      ok: true, judgment: { ...other, favorite: true, bookmark: true },
    });
    store.judgmentPatch("h", "a.png", { favorite: false });
    assertEquals(store.judgmentGet("h", "a.png"), { ...other, bookmark: true });
    store.judgmentPatch("h", "a.png", { favorite: true, bookmark: false });
    assertEquals(store.judgmentGet("h", "a.png"), { ...other, favorite: true });
    store.judgmentPatch("h", "a.png", { bookmark: true });
    store.judgmentPatch("h", "a.png", { vote: "up", notes: { neg: "changed" }, "plugins.det.faces": 3 });
    assertEquals(store.judgmentGet("h", "a.png"), {
      vote: "up", favorite: true, bookmark: true, notes: { neg: "changed" }, plugins: { det: { faces: 3 } },
    });
  } finally {
    store.close();
    await rm(dir, { recursive: true });
  }
});

Deno.test("judgment: false/null bookmarks prune to absence in reads, raw rows and export", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-jbookmark-prune-"));
  const store = await Store.open(dir);
  try {
    for (const value of [false, null]) {
      assertEquals(store.judgmentPatch("h", "a.png", { bookmark: true }).ok, true);
      assertEquals(store.judgmentPatch("h", "a.png", { bookmark: value }), { ok: true, judgment: null });
      assertEquals(store.entryGet("h", "a.png").bookmark, null);
      assertEquals(store.feedbackExport("h").entries, {});
    }
    assertEquals(store.judgmentPatch("h", "empty.png", { bookmark: false }).judgment, null);
    const raw = new Database(join(dir, "metadata.db"));
    try {
      assertEquals(raw.prepare("SELECT name, bookmark FROM entry ORDER BY name").all(), [
        { name: "a.png", bookmark: null }, { name: "empty.png", bookmark: null },
      ]);
    } finally {
      raw.close();
    }
  } finally {
    store.close();
    await rm(dir, { recursive: true });
  }
});

Deno.test("judgment: bookmarks persist after reopen and stay per-entry with a shared hash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-jbookmark-reopen-"));
  let store = await Store.open(dir);
  try {
    const hash = "bc".repeat(32);
    await store.ingestFile("a", "same.png", hash, 10);
    await store.ingestFile("a", "copy.png", hash, 10);
    await store.ingestFile("b", "same.png", hash, 10);
    assertEquals((await store.judgmentSet("a", "same.png", "bookmark", true)).ok, true);
    store.judgmentPatch("a", "copy.png", { favorite: true });
    store.close();
    store = await Store.open(dir);
    assertEquals(store.judgmentGet("a", "same.png"), { bookmark: true });
    assertEquals(store.judgmentGet("a", "copy.png"), { favorite: true });
    assertEquals(store.judgmentGet("b", "same.png"), null);
    assertEquals(store.entryGet("a", "same.png").bookmark, 1);
    assertEquals(store.entryJoined("a", "same.png").bookmark, 1);
    assertEquals(store.entriesForCollection("a").map((r) => [r.name, r.bookmark]).sort(), [["copy.png", null], ["same.png", 1]]);
    store.judgmentPatch("b", "same.png", { bookmark: true });
    store.judgmentPatch("a", "same.png", { bookmark: false });
    assertEquals(store.judgmentGet("a", "same.png"), null);
    assertEquals(store.judgmentGet("b", "same.png"), { bookmark: true });
    assertEquals(store.judgmentGet("a", "copy.png"), { favorite: true });
  } finally {
    store.close();
    await rm(dir, { recursive: true });
  }
});

Deno.test("judgment: bookmark-only export includes hashed and unhashed entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-jbookmark-export-"));
  const store = await Store.open(dir);
  try {
    const hash = "cd".repeat(32);
    await store.ingestFile("h", "hashed.png", hash, 10);
    assertEquals(store.judgmentPatch("h", "hashed.png", { bookmark: true }).ok, true);
    store.judgmentPatch("h", "unhashed.png", { bookmark: true });
    store.judgmentPatch("h", "favorite.png", { favorite: true });
    store.judgmentPatch("other", "other.png", { bookmark: true });
    const expected = {
      "favorite.png": { favorite: true }, "hashed.png": { hash, bookmark: true }, "unhashed.png": { bookmark: true },
    };
    assertEquals(store.feedbackExport("h").entries, expected);
    const router = makeRouter({ store, hosts: {} });
    const res = await router.handle(new Request("http://test/api/collections/h/feedback.json"));
    assertEquals(res.status, 200);
    const doc = await res.json();
    assertEquals(doc.version, 2);
    assertEquals(doc.collection, "h");
    assertEquals(doc.entries, expected);
  } finally {
    store.close();
    await rm(dir, { recursive: true });
  }
});

Deno.test("judgment: PATCH, entry read and folder listing expose bookmark independently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-jbookmark-route-"));
  const store = await Store.open(dir);
  try {
    await writeFile(join(dir, "a.png"), "fake image");
    await writeFile(join(dir, "b.png"), "fake image");
    const address = `folder:${dir}`;
    store.collectionAdd("h", address);
    store.judgmentPatch("h", "b.png", { favorite: true });
    const router = makeRouter({ store, hosts: { h: address } });
    const url = "http://test/api/collections/h/entries/a.png";
    const patched = await router.handle(new Request(`${url}/judgment`, { method: "PATCH", body: JSON.stringify({ bookmark: true }) }));
    assertEquals(patched.status, 200);
    assertEquals(await patched.json(), { bookmark: true });
    const single = await router.handle(new Request(url));
    assertEquals((await single.json()).judgment, { bookmark: true });
    const listed = await router.handle(new Request("http://test/api/collections/h/entries"));
    assertEquals(listed.status, 200);
    const rows = new Map((await listed.json()).map((r) => [r.name, r]));
    assertEquals(rows.get("a.png").judgment, { bookmark: true });
    assertEquals(rows.get("b.png").judgment, { favorite: true });
    const cleared = await router.handle(new Request(`${url}/judgment`, { method: "PATCH", body: JSON.stringify({ bookmark: false }) }));
    assertEquals(cleared.status, 200);
    assertEquals(await cleared.json(), {});
    assertEquals((await (await router.handle(new Request(url))).json()).judgment, null);
  } finally {
    store.close();
    await rm(dir, { recursive: true });
  }
});

Deno.test("judgment: legacy favorite import never creates or clears bookmarks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-jbookmark-import-"));
  let store = await Store.open(dir);
  try {
    const hash = "de".repeat(32);
    await store.ingestFile("a", "same.png", hash, 10);
    await store.ingestFile("b", "same.png", hash, 10);
    assertEquals(store.judgmentPatch("a", "same.png", { bookmark: true }).ok, true);
    store.close();
    const feedbackPath = join(dir, "feedback.json");
    await writeFile(feedbackPath, JSON.stringify({ version: 1, data: {
      [hash]: { favorite: true, notes: { pos: "legacy" }, plugins: { det: { faces: 2 } } },
      "a:gone.png": { favorite: true },
    } }));
    store = await Store.open(dir, { feedbackPath });
    const imported = { favorite: true, notes: { pos: "legacy" }, plugins: { det: { faces: 2 } } };
    assertEquals(store.judgmentGet("a", "same.png"), { ...imported, bookmark: true });
    assertEquals(store.judgmentGet("b", "same.png"), imported);
    assertEquals(store.judgmentGet("a", "gone.png"), { favorite: true });
    assertEquals(store.entryGet("b", "same.png").bookmark, null);
    assertEquals(store.entryGet("a", "gone.png").bookmark, null);
  } finally {
    store.close();
    await rm(dir, { recursive: true });
  }
});

Deno.test("judgment: v7 to v8 migration adds nullable bookmark and preserves raw v7 data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-jbookmark-v7-"));
  const dbPath = join(dir, "metadata.db");
  const raw = new Database(dbPath);
  let before;
  try {
    raw.exec(`
      CREATE TABLE content (hash TEXT PRIMARY KEY, width INTEGER, height INTEGER, meta TEXT,
        has_workflow INTEGER NOT NULL DEFAULT 0, ext INTEGER NOT NULL DEFAULT 0, bytes INTEGER, updated_at REAL NOT NULL);
      CREATE TABLE collection (id TEXT PRIMARY KEY, kind TEXT NOT NULL, address TEXT, link TEXT, created_at REAL NOT NULL);
      CREATE TABLE entry (collection TEXT NOT NULL REFERENCES collection(id) ON DELETE CASCADE,
        name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'output', hash TEXT REFERENCES content(hash),
        stamp TEXT, state TEXT NOT NULL DEFAULT 'seen', vote TEXT, favorite INTEGER, notes TEXT, hidden INTEGER,
        plugin_fields TEXT, width INTEGER, height INTEGER, first_seen REAL NOT NULL, last_seen REAL NOT NULL,
        PRIMARY KEY (collection, name, kind));
      CREATE INDEX entry_by_hash ON entry(hash);
      CREATE TABLE node_registry (class_type TEXT PRIMARY KEY, title TEXT, inputs TEXT NOT NULL, updated_at REAL NOT NULL);
      CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT);
      INSERT INTO kv VALUES ('fold.v7', 'done'), ('meta_version', '123');
      INSERT INTO collection VALUES ('h', 'comfy', 'fake.invalid:8188', NULL, 1);
      INSERT INTO content VALUES ('shared', 20, 30, '{"seed":1}', 1, 2, 10, 2);
      INSERT INTO entry VALUES ('h', 'a.png', 'output', 'shared', 'stamp-a', 'ingested',
        'down', 1, '{"pos":"keep","neg":"raw"}', 1, '{"det":{"faces":2}}', 20, 30, 3, 4);
      INSERT INTO entry VALUES ('h', 'b.png', 'output', 'shared', 'stamp-b', 'gone',
        'up', NULL, NULL, NULL, NULL, NULL, NULL, 5, 6);
      INSERT INTO entry VALUES ('h', 'in.png', 'input', 'shared', 'stamp-in', 'ingested',
        NULL, NULL, NULL, NULL, NULL, 20, 30, 7, 8);
      PRAGMA user_version = 7;
    `);
    assertEquals(raw.prepare("PRAGMA user_version").value()[0], 7);
    assert(!raw.prepare("PRAGMA table_info(entry)").all().some((c) => c.name === "bookmark"));
    before = raw.prepare("SELECT * FROM entry ORDER BY name").all();
  } finally {
    raw.close();
  }
  let store = await Store.open(dir);
  try {
    assertEquals(store.judgmentGet("h", "a.png"), {
      vote: "down", favorite: true, notes: { pos: "keep", neg: "raw" }, plugins: { det: { faces: 2 } },
    });
    assertEquals(store.judgmentGet("h", "b.png"), { vote: "up" });
    const migrated = new Database(dbPath);
    try {
      assertEquals(migrated.prepare("PRAGMA user_version").value()[0], 8);
      const rows = migrated.prepare("SELECT * FROM entry ORDER BY name").all();
      assertEquals(rows.map(({ bookmark, ...rest }) => rest), before);
      assertEquals(rows.map((r) => r.bookmark), [null, null, null]);
      const column = migrated.prepare("PRAGMA table_info(entry)").all().find((c) => c.name === "bookmark");
      assertEquals(column.type, "INTEGER");
      assertEquals(column.notnull, 0);
      assertEquals(column.dflt_value, null);
      assertEquals(migrated.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      migrated.close();
    }
    assertEquals(store.metaVersion, 123);
    assertEquals(store.contentGet("shared").meta, { seed: 1 });
    store.judgmentPatch("h", "b.png", { bookmark: true });
    store.close();
    store = await Store.open(dir);
    assertEquals(store.judgmentGet("h", "b.png"), { vote: "up", bookmark: true });
    assertEquals(store.entryGet("h", "a.png").bookmark, null);
    assertEquals(store.entryGet("h", "in.png", "input").bookmark, null);
  } finally {
    store.close();
    await rm(dir, { recursive: true });
  }
});
