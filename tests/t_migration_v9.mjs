import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import { Database } from "@db/sqlite";
import { Store } from "../src/store.mjs";
import { mkStateRig } from "./helpers/rig.mjs";

Deno.test("migration v9: fresh flags, independent patches and reopen preserve all records", async () => {
  const rig = await mkStateRig("v9");
  try {
    rig.store.collectionAdd("a", "host:8188");
    rig.store.collectionAdd("b", "folder:/tmp", { pinned: true, autoRefresh: true });
    assertEquals(rig.store.collectionGet("a").pinned, 0);
    assertEquals(rig.store.collectionGet("a").auto_refresh, 0);
    await rig.store.ingestFile("a", "keep.png", "abc", 17, { dims: { width: 20, height: 30 } });
    rig.store.judgmentPatch("a", "keep.png", { bookmark: true, notes: { pos: "keep" }, vote: "up" });
    rig.store.collectionPatch("a", { pinned: true });
    rig.store.collectionPatch("a", { autoRefresh: true });
    rig.store.collectionPatch("a", { pinned: false });
    rig.store.collectionAdd("a", "host:8188", { pinned: true });
    rig.store.close();
    const s = await Store.open(rig.dir);
    try {
      assertEquals([s.collectionGet("a").pinned, s.collectionGet("a").auto_refresh], [0, 1]);
      assertEquals([s.collectionGet("b").pinned, s.collectionGet("b").auto_refresh], [1, 1]);
      assertEquals(s.collectionMap(), { a: "host:8188", b: "folder:/tmp" });
      assertEquals(s.hashFor("a", "keep.png"), "abc");
      assertEquals(s.entryDims("a", "keep.png"), { width: 20, height: 30 });
      assertEquals(s.contentGet("abc").bytes, 17);
      assertEquals(s.judgmentGet("a", "keep.png"), { bookmark: true, notes: { pos: "keep" }, vote: "up" });
    } finally { s.close(); }
  } finally { await rig.close(); }
});

for (const partial of [null, "pinned", "auto_refresh", "both"]) {
  Deno.test(`migration v9: v8/partial recovery ${partial}, constraints and idempotence`, async () => {
    const rig = await mkStateRig("v9-recovery");
    try {
      rig.store.collectionAdd("keep", "host:8188");
      rig.store.judgmentPatch("keep", "a.png", { favorite: true, bookmark: true });
      rig.store.close();
      const raw = new Database(`${rig.dir}/metadata.db`);
      for (const col of ["pinned", "auto_refresh"]) {
        if (partial !== col && partial !== "both") raw.exec(`ALTER TABLE collection DROP COLUMN ${col}`);
        else raw.exec(`UPDATE collection SET ${col} = 1`);
      }
      raw.exec("PRAGMA user_version = 8");
      raw.close();
      for (let i = 0; i < 2; i++) {
        const s = await Store.open(rig.dir);
        assertEquals(s.collectionGet("keep").pinned, partial === "pinned" || partial === "both" ? 1 : 0);
        assertEquals(s.collectionGet("keep").auto_refresh, partial === "auto_refresh" || partial === "both" ? 1 : 0);
        assertEquals(s.judgmentGet("keep", "a.png"), { favorite: true, bookmark: true });
        s.close();
      }
      const check = new Database(`${rig.dir}/metadata.db`);
      try {
        assertEquals(check.prepare("PRAGMA user_version").value()[0], 9);
        assertThrows(() => check.exec("UPDATE collection SET pinned = 2"));
        assertThrows(() => check.exec("UPDATE collection SET auto_refresh = NULL"));
        assert(check.prepare("PRAGMA foreign_key_check").all().length === 0);
      } finally { check.close(); }
    } finally { await rig.close(); }
  });
}
