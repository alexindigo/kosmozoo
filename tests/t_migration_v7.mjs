// tests/t_migration_v7.mjs — the v6→v7 fold against a real-shape v6 fixture
// (tests/fixtures/state-v6/, built by tests/make-state-v6.mjs): old tables
// fold into content/collection/entry and are dropped; settings namespaces
// move; judgments keep resolving; the fold is idempotent.

import { assert, assertEquals } from "jsr:@std/assert";
import { Store } from "../src/store.mjs";
import { Settings } from "../src/settings.mjs";
import { Database } from "@db/sqlite";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE = new URL("./fixtures/state-v6/", import.meta.url).pathname;

const H1 = "aa".repeat(32), H2 = "bb".repeat(32), H3 = "cc".repeat(32);
const H4 = "dd".repeat(32), H5 = "ee".repeat(32), H6 = "ff".repeat(32);
const H7 = "77".repeat(32), H9 = "99".repeat(32);

async function openFixture() {
  const dir = await mkdtemp(join(tmpdir(), "kz-v7-"));
  await cp(FIXTURE, dir, { recursive: true });
  const settings = await Settings.open(dir);
  const store = await Store.open(dir, { settings, feedbackPath: join(dir, "feedback.json") });
  return { dir, settings, store };
}

Deno.test("migration v7: tables folded, old tables dropped, idempotent", async () => {
  const { dir, store } = await openFixture();
  try {
    // collections from the settings hosts map
    assertEquals(store.collectionGet("a"), {
      id: "a", kind: "comfy", address: "1.2.3.4:8188", link: null,
      created_at: store.collectionGet("a").created_at,
    });
    assertEquals(store.collectionGet("b").kind, "folder");
    assertEquals(store.collectionGet("b").address, "folder:/var/images");

    // hash identity: two entries, one content row (shared bytes)
    assertEquals(store.hashFor("a", "shared.png"), H1);
    assertEquals(store.hashFor("b", "shared.png"), H1);
    // dropped nopng marker → placeholder content row (ext=0 → re-walked);
    // input rows hold hashes too
    assertEquals(store.contentGet(H9)?.ext, 0);
    assertEquals(store.contentGet(H9)?.meta, null);
    assertEquals(store.contentGet(H5)?.hash, H5);

    // images row beat the older duplicate metadata row
    assertEquals(store.metaState("a", "shared.png").meta, { seed: 1, steps: 20 });
    assertEquals(store.metaState("b", "shared.png").meta, { seed: 1, steps: 20 });
    // metadata-only rows folded via files.hash
    assertEquals(store.metaState("a", "legacy.png").meta, { seed: 4 });
    assertEquals(store.metaState("b", "meta-only.png").meta, { seed: 3 });
    // discarded classes
    assertEquals(store.metaState("a", "unhashed.png").meta, null);
    assertEquals(store.metaState("a", "nopng.png").meta, null); // marker gone; ext=0 row re-walks

    // entry states + stamps
    assertEquals(store.fileInfo("a", "shared.png"), { hash: H1, stamp: "st-a-shared" });
    assertEquals(store.fileInfo("b", "shared.png"), { hash: H1, stamp: "st-b-shared" });
    assertEquals(store.fileInfo("a", "unhashed.png"), { hash: null, stamp: null });

    // input_cache -> kind='input' entries
    assertEquals(store.inputCacheGet("a", "in.png"), { hash: H5, stamp: "st-in-a" });
    assertEquals(store.inputCacheGet("b", "deep.png"), { hash: H6, stamp: "st-in-b" });

    // hidden landed on entries (incl. ghost.png, which had no files row)
    assertEquals([...store.hiddenNames("a")].sort(), ["ghost.png", "shared.png"]);
    assertEquals([...store.hiddenNames("b")], []);
    const meta1 = store.metaVersion;
    assert(meta1 > 0, "meta_version seeded in kv");

    // judgments fanned out from the v1 feedback document to ENTRY COLUMNS:
    // BOTH entries sharing H1 carry the judgment (per-entry model)
    assertEquals(store.judgmentGet("a", "shared.png"), { vote: "up" });
    assertEquals(store.judgmentGet("b", "shared.png"), { vote: "up" });
    // and they are independent afterwards
    store.judgmentPatch("a", "shared.png", { vote: "down" });
    assertEquals(store.judgmentGet("a", "shared.png"), { vote: "down" });
    assertEquals(store.judgmentGet("b", "shared.png"), { vote: "up" });
    // legacy keys: missing entries were created with state='gone', judgment kept
    assertEquals(store.entryGet("a", "old-key.png").state, "gone");
    assertEquals(store.judgmentGet("a", "old-key.png"), { vote: "down", notes: { pos: "keep" } });
    assertEquals(store.entryGet("orphan", "gone.png").state, "gone");
    assertEquals(store.judgmentGet("orphan", "gone.png"), { favorite: true });
    // the v1 document was COPIED (left in place; the done flag prevents
    // re-import), and a backup copy exists
    const remaining = [];
    for await (const f of Deno.readDir(dir)) remaining.push(f.name);
    assert(remaining.includes("feedback.json"), "the v1 file stays (copy, not rename)");
    assert(remaining.some((f) => f.startsWith("feedback.json.v1-backup-")), "backup copy exists");

    store.close();

    // the old tables are gone and the fold is idempotent on re-open
    const raw = new Database(join(dir, "metadata.db"));
    const [ver] = raw.prepare("PRAGMA user_version").value();
    assertEquals(ver, 7);
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
    assert(tables.includes("content") && tables.includes("collection") && tables.includes("entry") && tables.includes("kv"));
    for (const old of ["metadata", "files", "images", "input_cache"]) {
      assert(!tables.includes(old), `${old} should be dropped`);
    }
    raw.close();

    const store2 = await Store.open(dir, {
      settings: await Settings.open(dir),
      feedbackPath: join(dir, "feedback.json"),
    });
    assertEquals(store2.metaState("a", "shared.png").meta, { seed: 1, steps: 20 });
    assertEquals(store2.metaVersion, meta1);
    store2.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

Deno.test("migration v7: settings namespaces folded and deleted", async () => {
  const { dir, settings, store } = await openFixture();
  try {
    // hosts map is gone from settings (lives in collections now)
    assertEquals(settings.get("core.hosts", "map", null), null);
    // hidden list is gone from settings (lives on entries now)…
    assertEquals(settings.get("core.delete", "hidden", null), null);
    // …but its sibling key survives
    assertEquals(settings.get("core.delete", "useAssetsPlus", null), true);
    // hidden entries carry the flag
    assertEquals([...store.hiddenNames("a")].sort(), ["ghost.png", "shared.png"]);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

Deno.test("migration v7: a hash-keyed judgment with no entry row is recovered via its ref; stats recorded", async () => {
  const { dir, store } = await openFixture();
  try {
    // the fixture's H7 judgment matches no files/metadata row anywhere —
    // the ref ("a:ref-only.png") names the entry, which is created gone
    // with the hash set, judgment applied, nothing dropped
    const e = store.entryGet("a", "ref-only.png");
    assertEquals(e.state, "gone");
    assertEquals(e.hash, H7);
    assertEquals(store.judgmentGet("a", "ref-only.png"), { vote: "up" });
    // plugins pruned to empty are stored as ABSENT, never "{}";
    // real plugin fields survive into plugin_fields
    assertEquals(store.entryGet("a", "plugins-empty.png").plugin_fields, null);
    assertEquals(store.judgmentGet("a", "plugins-empty.png"), { vote: "down" });
    assertEquals(store.judgmentGet("a", "plugins-real.png"), {
      favorite: true, plugins: { det: { faces: 2 } },
    });
    // the fold's import stats: nothing dropped, the orphan recovered via ref
    const raw = new Database(join(dir, "metadata.db"));
    const [statsJson] = raw.prepare("SELECT v FROM kv WHERE k = 'fold.feedback.v2.stats'").value();
    const stats = JSON.parse(statsJson);
    assertEquals(stats.dropped, 0);
    assertEquals(stats.orphansByRef, 1);
    raw.close();
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

Deno.test("migration v7: FKs enforced — no orphans after the fold, cascade on collection delete", async () => {
  const { dir, store } = await openFixture();
  try {
    // host d is only on the hidden list (no files row): the fold created
    // its collection first, so the hidden entry does not orphan
    const d = store.collectionGet("d");
    assertEquals(d.kind, "comfy");
    assertEquals(d.address, null);
    assertEquals(store.entryGet("d", "hidden-host.png").hidden, 1);
    // host c appears in files but not in the hosts map: offline placeholder
    const c = store.collectionGet("c");
    assertEquals(c.kind, "comfy");
    assertEquals(c.address, null);
    assertEquals(store.entryGet("c", "c-file.png").state, "seen");

    // the cascade is real AND the store's own connection enforces it (the
    // pragma is per-connection — only a delete through the store proves
    // Store.open turned it on)
    store.collectionRemove("b");
    store.close();
    const raw = new Database(join(dir, "metadata.db"));
    assertEquals(raw.prepare("PRAGMA foreign_key_check").all(), []);
    assertEquals(raw.prepare("SELECT COUNT(*) FROM entry WHERE collection = 'b'").value()[0], 0);
    assertEquals(raw.prepare("PRAGMA foreign_key_check").all(), []);
    raw.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

Deno.test("migration v7: a non-ENOENT feedback read error fails the boot — no done flag, path reported", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-v7-eacc-"));
  await cp(FIXTURE, dir, { recursive: true });
  // the suite runs as root in docker, where chmod 000 is bypassed — a
  // DIRECTORY at the feedback path produces the same non-ENOENT read error
  const fb = join(dir, "feedback.json");
  await rm(fb);
  await mkdir(fb);
  let err = null;
  try {
    await Store.open(dir, { settings: await Settings.open(dir), feedbackPath: fb });
  } catch (e) {
    err = e;
  }
  assert(err, "the boot must fail, not present an empty judgment table");
  assert(String(err.message).includes(fb), `the path is in the error: ${err.message}`);
  assert(String(err.message).includes("EISDIR"), `the code is in the error: ${err.message}`);
  // the done flag was NOT written — the next boot retries the import
  const raw = new Database(join(dir, "metadata.db"));
  assertEquals(raw.prepare("SELECT v FROM kv WHERE k = 'fold.feedback.v2'").value()?.[0] ?? null, null);
  raw.close();
  await rm(dir, { recursive: true, force: true });
});
