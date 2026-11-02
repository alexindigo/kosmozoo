import { assertEquals, assert } from "jsr:@std/assert";
import { entryNames } from "../client-solid/store/entry-names.js";

Deno.test("copy/save names: default-on source tag, leaf download and full-path reference", () => {
  const entry = { host: "comfyui", filename: "day/portrait/Qwen_image_00001_.png" };
  assertEquals(entryNames(entry), {
    download: "comfyui#Qwen_image_00001_.png",
    reference: "comfyui#day/portrait/Qwen_image_00001_.png",
  });
  assertEquals(entryNames(entry, { sourcePrefix: false }), {
    download: "Qwen_image_00001_.png",
    reference: "day/portrait/Qwen_image_00001_.png",
  });
});

Deno.test("copy/save names: an existing leading tag is never doubled or removed from the stored name", () => {
  for (const sourcePrefix of [true, false]) {
    assertEquals(entryNames({ host: "ark", filename: "ark#image.png" }, { sourcePrefix }), {
      download: "ark#image.png", reference: "ark#image.png",
    });
  }
  assertEquals(entryNames({ host: "ark", filename: "ark#folder/image.png" }), {
    download: "ark#image.png", reference: "ark#folder/image.png",
  });
  assertEquals(entryNames({ host: "ark", filename: "folder/ark#image.png" }), {
    download: "ark#image.png", reference: "ark#folder/ark#image.png",
  });
});

Deno.test("download names are portable; clipboard text retains exact source/path identity", () => {
  const entry = { host: 'a:b/c\\d<>"|?*\0', filename: "nested/picture?.png. " };
  assertEquals(entryNames(entry), {
    download: "a_b_c_d_______#picture_.png",
    reference: entry.host + "#" + entry.filename,
  });
  assertEquals(entryNames(entry, { sourcePrefix: false }).download, "picture_.png");
  for (const filename of ["CON.png", "aux", "LPT1.jpeg", "com¹.png"]) {
    assertEquals(entryNames({ host: "ark", filename }, { sourcePrefix: false }).download, "_" + filename);
  }
  assertEquals(entryNames({ host: "ark", filename: "... " }, { sourcePrefix: false }).download, "image");
});

Deno.test("download name budget includes source tag and preserves Unicode and extension", () => {
  const name = entryNames({ host: "源".repeat(90), filename: "😀".repeat(100) + ".png" }).download;
  assert(new TextEncoder().encode(name).length <= 255);
  assert(name.endsWith(".png"));
  assert(!name.includes("�"));
});
