// tests/t_capabilities.mjs — the ONE capabilities derivation: folder →
// unlink, comfy + assets_plus → trash, comfy without → hide, offline comfy
// → hide, virtual → the schema slot only.

import { assertEquals } from "jsr:@std/assert";
import { capabilities } from "../src/collections.mjs";

const withPlus = { hasAssetsPlus: async () => true };
const withoutPlus = { hasAssetsPlus: async () => false };

Deno.test("capabilities: folder → unlink (permanent)", async () => {
  const caps = await capabilities({ kind: "folder", address: "folder:/var/images" });
  assertEquals(caps.delete, "unlink");
  assertEquals(caps.add, false);
});

Deno.test("capabilities: comfy + assets_plus → trash", async () => {
  const caps = await capabilities({ kind: "comfy", address: "h:8188" }, { comfy: withPlus });
  assertEquals(caps.delete, "trash");
});

Deno.test("capabilities: comfy without assets_plus → hide", async () => {
  const caps = await capabilities({ kind: "comfy", address: "h:8188" }, { comfy: withoutPlus });
  assertEquals(caps.delete, "hide");
});

Deno.test("capabilities: offline comfy → hide (never guessed trash)", async () => {
  const caps = await capabilities({ kind: "comfy", address: "h:8188" }, { online: false, comfy: withPlus });
  assertEquals(caps.delete, "hide");
});

Deno.test("capabilities: useAssetsPlus off → hide even with the extension", async () => {
  const caps = await capabilities({ kind: "comfy", address: "h:8188" }, { useAssetsPlus: false, comfy: withPlus });
  assertEquals(caps.delete, "hide");
});

Deno.test("capabilities: virtual → the schema slot only (future)", async () => {
  const caps = await capabilities({ kind: "virtual", address: null });
  assertEquals(caps, { list: false, read: false, add: false, delete: false, rename: false });
});
