import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import { editorRig } from "./helpers/variation-editor.mjs";
import { uploadCandidate, uploadFamily } from "../src/features/variations/shared.mjs";
import { generatePermutations } from "../src/features/variations/shared.mjs";

const id = "image.image";
const input = name => ({ kind: "input", name });
const upload = file => ({ kind: "upload", name: file.name, file });

Deno.test("image set: moving mixed items preserves File identity and compiled variation order", async () => {
  const { editor, requests } = editorRig(), file = new File(["image"], "upload.png");
  editor.edit("numeric", "n.denoise", "enabled", false); editor.edit("images", id, "enabled", true);
  editor.addImages(id, [input("first.png"), upload(file), input("third.png"), input("fourth.png")]);
  assert(editor.moveImage(id, input("third.png"), 0));
  assertEquals(editor.rows("images")[id].items.map(item => item.name), ["third.png", "first.png", "upload.png", "fourth.png"]);
  assert(editor.moveImage(id, input("third.png"), 1));
  assert(!editor.moveImage(id, input("third.png"), -1));
  assert(!editor.moveImage(id, input("third.png"), 1));
  assertEquals(editor.rows("images")[id].items[2].file, file);
  await editor.run();
  const expected = ["first.png", "third.png", "upload.png", "fourth.png"];
  assertEquals(requests[0].imageParams[id].values, expected);
  assertEquals(generatePermutations({}, { [id]: "origin.png" }, requests[0].imageParams).map(permutation => permutation[id]), expected);
  assertEquals(editor.remaining(), []); editor.dispose();
});

Deno.test("image set: collision families preserve literal punctuation, nested counters and stock dotfile splitting", () => {
  assertEquals(uploadCandidate("name %.png", 2), "name % (2).png");
  assertEquals(uploadCandidate("name (1).png", 1), "name (1) (1).png");
  assertEquals(uploadCandidate(".png", 1), ".png (1)");
  assertEquals(uploadFamily("name %.png", ["name %.png", "name % (1).png", "name % (01).png", "name (2).png", "name % (3).jpg"]), ["name %.png", "name % (1).png"]);
});

Deno.test("image set: acquisition is additive, identity-deduplicated and removable without changing native Files", () => {
  const { editor } = editorRig(), a = new File(["a"], "same.png"), b = new File(["b"], "same.png");
  editor.addImages(id, [input("next.png"), upload(a)]);
  editor.addImages(id, [input("next.png"), upload(a), upload(b)]);
  const items = editor.rows("images")[id].items;
  assertEquals(items.length, 3); assert(items[1].file === a && items[2].file === b);
  editor.removeImage(id, items[0]); assertEquals(editor.rows("images")[id].items.length, 2);
  assertThrows(() => editor.edit("images", id, "mode", "files"));
  assertThrows(() => editor.edit("images", id, "items", [input("../bad.png")]));
  editor.dispose();
});

Deno.test("image set: catalogue settlement never selects the first input or replaces chosen work", () => {
  const { editor, context } = editorRig();
  assertEquals(editor.rows("images")[id].items, []); assert(!editor.dirty());
  editor.addImages(id, [input("next.png")]);
  editor.installInputs({ origin: context.origin, files: ["new-first.png"] });
  assertEquals(editor.rows("images")[id].items, [input("next.png")]); editor.dispose();
});

Deno.test("image set: same-current bytes are marked before Run, counted like the current name and never uploaded", async () => {
  const rig = editorRig({ inspectImage: async (_host, file, _current, _kind, origin) => ({ hash: file.name === "copy.png" ? "a".repeat(64) : "b".repeat(64), currentHash: "a".repeat(64), origin }) });
  const { editor } = rig;
  editor.edit("numeric", "n.denoise", "enabled", false); editor.edit("images", id, "enabled", true);
  editor.addImages(id, [input("origin.png"), input("next.png"), upload(new File(["current"], "copy.png"))]);
  await editor.inspectImages();
  assertEquals(editor.rows("images")[id].images.map(item => item.sameCurrent), [true, false, true]);
  assertEquals(editor.preview().n, 1); assert(editor.preview().exact);
  assertEquals((await editor.run()).submitted, 1);
  assertEquals(rig.uploads.length, 0); assertEquals(rig.requests[0].imageParams[id].values, ["origin.png", "next.png"]);
  assertEquals(editor.remaining(), []); rig.fireTimers(); assertEquals(rig.closeCount(), 1); editor.dispose();
});

Deno.test("image set: mixed captured input and File items compile in order and acknowledge one set leaf", async () => {
  const rig = editorRig(), { editor } = rig, file = new File(["new"], "upload.png");
  editor.edit("images", id, "enabled", true); editor.addImages(id, [input("next.png")]); editor.addImages(id, [upload(file)]);
  await editor.inspectImages(); const preview = editor.preview().n;
  assertEquals((await editor.run()).submitted, preview);
  assertEquals(rig.requests[0].imageParams[id].values, ["next.png", "upload.png"]);
  assertEquals(editor.remaining(), []); assert(editor.rows("images")[id].items[1].file === file); editor.dispose();
});

Deno.test("image set: failed inspection is visible, retains work and prevents unverified upload or enqueue", async () => {
  const rig = editorRig({ inspectImage: async () => { throw new Error("input bytes unavailable"); } }), { editor } = rig;
  editor.edit("images", id, "enabled", true); editor.addImages(id, [upload(new File(["x"], "kept.png"))]);
  await editor.inspectImages(); assert(editor.rows("images")[id].images[0].error.includes("unavailable"));
  assertEquals((await editor.run()).status, "invalid"); assertEquals(rig.uploads.length, 0); assertEquals(rig.requests.length, 0); assert(editor.dirty()); editor.dispose();
});

Deno.test("image set: preview distinguishes same-name different bytes and unifies actual same-name content dedupe", async () => {
  const rig = editorRig({
    inspectImage: async (_host, file, _current, _kind, origin) => ({ hash: (await file.text() === "a" ? "b" : "c").repeat(64), currentHash: "a".repeat(64), origin }),
    uploadInput: async (_host, form, origin) => ({ name: await form.get("image").text() === "a" ? "same.png" : "same (1).png", origin }),
  });
  const { editor } = rig;
  editor.edit("numeric", "n.denoise", "enabled", false); editor.edit("images", id, "enabled", true);
  const files = [new File(["a"], "same.png"), new File(["b"], "same.png"), new File(["a"], "same.png")];
  editor.addImages(id, files.map(upload)); await editor.inspectImages();
  assertEquals(editor.rows("images")[id].items.length, 3); assertEquals(editor.preview().n, 2); assert(editor.preview().exact);
  const result = await editor.run(); assertEquals(result.submitted, 2); assertEquals(result.adopted, true);
  assertEquals(rig.requests[0].imageParams[id].values, ["same.png", "same (1).png"]); assertEquals(editor.remaining(), []); editor.dispose();
});

Deno.test("image set: preview shares existing collision aliases across inputs, repeated acquisitions and upload order", async () => {
  const originHash = "a".repeat(64), uploadHash = "b".repeat(64), occupiedHash = "c".repeat(64);
  const rig = editorRig({
    inspectImage: async (_host, file, _current, _kind, origin) => ({ hash: await file.text() === "new" ? uploadHash : occupiedHash, currentHash: originHash,
      existing: [{ name: "same.png", hash: occupiedHash }, { name: "same (1).png", hash: uploadHash }], origin }),
    uploadInput: async (_host, form, origin) => ({ name: await form.get("image").text() === "new" ? "same (1).png" : "same.png", origin }),
  });
  const { editor } = rig;
  editor.edit("numeric", "n.denoise", "enabled", false); editor.edit("images", id, "enabled", true);
  editor.addImages(id, [input("same (1).png"), upload(new File(["new"], "same.png"))]);
  await editor.inspectImages(); assertEquals(editor.preview().n, 1); assertEquals((await editor.run()).submitted, 1);
  editor.addImages(id, [upload(new File(["old"], "same.png"))]); await editor.inspectImages();
  assertEquals(editor.preview().n, 2); assertEquals((await editor.run()).submitted, 2);
  assertEquals(rig.requests[1].imageParams[id].values, ["same (1).png", "same.png"]); assertEquals(editor.remaining(), []); editor.dispose();
});

Deno.test("image set: confirmed uploaded names survive set removal and inform later acquisitions in the same editor", async () => {
  const rig = editorRig({
    inspectImage: async (_host, file, _current, _kind, origin) => ({ hash: (await file.text() === "old" ? "c" : "b").repeat(64), currentHash: "a".repeat(64),
      existing: [{ name: "same (1).png", hash: "b".repeat(64) }], origin }),
    uploadInput: async (_host, form, origin) => ({ name: await form.get("image").text() === "old" ? "same.png" : "same (1).png", origin }),
  });
  const { editor } = rig, old = upload(new File(["old"], "same.png"));
  editor.edit("numeric", "n.denoise", "enabled", false); editor.edit("images", id, "enabled", true);
  editor.addImages(id, [old]); assertEquals((await editor.run()).submitted, 1);
  editor.removeImage(id, old); editor.addImages(id, [input("same (1).png"), upload(new File(["new"], "same.png"))]);
  await editor.inspectImages(); assertEquals(editor.preview().n, 1); assertEquals((await editor.run()).submitted, 1); assertEquals(editor.remaining(), []); editor.dispose();
});
