import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import { isEntryPath, folderAncestors, inventoryFolders } from "../src/entry-path.mjs";

Deno.test("deepscan B paths: reject excessive path/depth before expanding ancestors", () => {
  assertEquals(isEntryPath("a/".repeat(128) + "image.png"), false);
  assertEquals(isEntryPath("a".repeat(4097)), false);
  assertThrows(() => folderAncestors("a/".repeat(128) + "image.png"), TypeError);
  assertEquals(folderAncestors("a/b/c.png"), ["a", "a/b"]);
  assertEquals(inventoryFolders([{ name: "a/b/1.png" }, { name: "a/b/2.png" }, { name: "a/c/3.png" }]), ["", "a", "a/b", "a/c"]);
});

Deno.test("deepscan B paths: published folder strings have an aggregate budget", () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ name: String(i).padStart(3, "0") + "/" + ("a".repeat(28) + "/").repeat(120) + "image.png" }));
  assert(items.every(item => isEntryPath(item.name)));
  assertThrows(() => inventoryFolders(items), RangeError);
});
