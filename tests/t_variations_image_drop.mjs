import { assert, assertEquals } from "jsr:@std/assert";
import { classifyImageFiles, droppedFiles, imageInsertIndex, isFileDrag, nearestImageTile } from "../client-solid/features/variations/image-drop.js";
import { editorRig } from "./helpers/variation-editor.mjs";

Deno.test("image drop: classifies native Files, skips nonimages and reports folders without expanding", () => {
  const image = new File(["png"], "photo.PNG"), text = new File(["text"], "notes.txt");
  const transfer = { types: ["Files"], items: [
    { kind: "file", getAsFile: () => image },
    { kind: "file", getAsFile: () => text },
    { kind: "file", webkitGetAsEntry: () => ({ isDirectory: true }), getAsFile: () => { throw Error("folder read"); } },
    { kind: "string", getAsFile: () => { throw Error("string read"); } },
  ] };
  assert(isFileDrag(transfer)); assert(!isFileDrag({ types: ["text/plain"], items: [] }));
  const result = classifyImageFiles(droppedFiles(transfer), name => /\.png$/i.test(name));
  assert(result.images[0] === image);
  assertEquals(result.status, "1 file skipped — not images · Folders: use Add folder");
  assertEquals(classifyImageFiles({ files: [text, text] }, () => false).status, "2 files skipped — not images");
  assertEquals(droppedFiles({ files: [image] }).files, [image]);
});

Deno.test("image drop: insertion uses reorder centres across wrapped rows and append boundaries", () => {
  const tiles = [{ x: 0, y: 0, width: 100, height: 100 }, { x: 106, y: 0, width: 100, height: 100 },
    { x: 0, y: 106, width: 100, height: 100 }];
  assertEquals(nearestImageTile(tiles, 103, 50), 0);
  assertEquals(imageInsertIndex(tiles, 103, 50), 1);
  assertEquals(imageInsertIndex(tiles, 140, 50), 1);
  assertEquals(imageInsertIndex(tiles, 180, 50), 2);
  assertEquals(imageInsertIndex(tiles, 20, 140), 2);
  assertEquals(imageInsertIndex(tiles, 103, 150), 3);
  assertEquals(imageInsertIndex(tiles, 0, 250), 3);
  assertEquals(imageInsertIndex([], 0, 0), 0);
});

Deno.test("image drop: indexed acquisition retains identities, deduplicates once and compiles the inserted order", async () => {
  const { editor, requests } = editorRig(), id = "image.image";
  const first = { kind: "input", name: "first.png" }, last = { kind: "input", name: "last.png" };
  const file = new File(["image"], "between.png"), upload = { kind: "upload", name: file.name, file };
  editor.edit("numeric", "n.denoise", "enabled", false); editor.edit("images", id, "enabled", true);
  editor.removeImage(id, editor.rows("images")[id].items[0]);
  editor.addImages(id, [first, last]); editor.addImages(id, [upload, upload, first], 1);
  const items = editor.rows("images")[id].items;
  assertEquals(items.map(item => item.name), ["first.png", "between.png", "last.png"]);
  assert(items[1].file === file);
  assertEquals((await editor.run()).status, "submitted");
  assertEquals(requests[0].imageParams[id].values, ["first.png", "between.png", "last.png"]);
  editor.dispose();
});
