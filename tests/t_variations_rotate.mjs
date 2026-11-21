import { assert, assertEquals, assertStrictEquals, assertThrows } from "jsr:@std/assert";
import { register } from "../src/features/variations/server.mjs";
import { makeCollectionLifecycle } from "../src/backings/index.mjs";
import { makeVariationEditor } from "../client-solid/features/variations/editor.js";
import { composeRotation, rotatedName } from "../client-solid/features/variations/image-rotate.js";

Deno.test("rotation: quarter turns compose to the original in both directions", () => {
  const turns = direction => { let degrees = 0; const seen = []; for (let i = 0; i < 4; i++) seen.push(degrees = composeRotation(degrees, direction)); return seen; };
  assertEquals(turns("cw"), [90, 180, 270, 0]);
  assertEquals(turns("ccw"), [270, 180, 90, 0]);
  assertEquals(composeRotation(composeRotation(0, "cw"), "ccw"), 0);
  assertThrows(() => composeRotation(45, "cw")); assertThrows(() => composeRotation(0, "left"));
});

Deno.test("rotation: names use the original stem and the angle", () => {
  assertEquals(rotatedName("photo.jpeg", 90), "photo_r90.png");
  assertEquals(rotatedName("nested/dir/a [b].png", 180), "a [b]_r180.png");
  assertEquals(rotatedName("plain", 270), "plain_r270.png");
  assertEquals(rotatedName(".png", 90), ".png_r90.png");
  assertThrows(() => rotatedName("a.png", 0));
});

async function rig(current = "same.png [input]") {
  const graph = {
    image: { class_type: "LoadImage", inputs: { image: current } },
    n: { class_type: "Sampler", inputs: { denoise: 1, image: ["image", 0] } },
    out: { class_type: "SaveImage", inputs: { filename_prefix: "source", images: ["n", 0] } },
  };
  const hosts = { fake: "fake:8188" }, lifecycle = makeCollectionLifecycle(hosts), routes = new Map();
  const backing = { objectInfo: async () => ({ types: new Map([["Sampler.denoise", "FLOAT"]]), enums: new Map(), outputClasses: new Set(["SaveImage"]) }) };
  register({ hosts, store: { hashFor: () => "a".repeat(64) }, ingest: { graph: async () => structuredClone(graph) },
    backings: { capture: lifecycle.capture, isCurrent: lifecycle.isCurrent, comfy: () => backing, accepting: () => true,
      source: id => { const token = lifecycle.capture(id); return { address: token.address, kind: "comfy", incarnation: token.incarnation,
        sourceVersion: { epoch: "test", incarnation: token.incarnation } }; } },
    route: (method, path, handler) => routes.set(method + path, handler) });
  const id = "fake:source.png", response = await routes.get("GET/probe/<id>")(new Request("http://x/probe/" + encodeURIComponent(id)), { id });
  const catalogue = await response.json(), origin = catalogue.context.origin;
  const rotations = [], reads = [];
  const control = { fail: null, hold: null };
  const editor = makeVariationEditor({ targets: [{ id, host: "fake", filename: "source.png", origin }], currentOrigin: () => origin,
    setTimer: () => 0, clearTimer() {}, services: {
      inspectImage: async (_host, _file, _name, _kind, expected) => ({ hash: "b".repeat(64), currentHash: "a".repeat(64), origin: expected }),
      readInput: async (source, name, root) => { reads.push({ source, name, root }); return new File([`bytes of ${name}`], name.split("/").at(-1)); },
      rotateImage: async (blob, degrees, name) => {
        rotations.push({ blob, degrees, name });
        if (control.hold) await control.hold;
        if (control.fail) throw new Error(control.fail);
        return new File([`${await blob.text()} @${degrees}`], name, { type: "image/png" });
      } } });
  editor.installCatalogue(catalogue);
  return { editor, origin, rotations, reads, control };
}
const ID = "image.image";

Deno.test("rotation: an upload turns in place from its original bytes; four turns restore the exact item", async () => {
  const { editor, rotations } = await rig();
  try {
    editor.setEnabled(ID, true);
    const original = new File(["pixels"], "photo.jpg"), other = new File(["other"], "other.png");
    editor.addImages(ID, [{ kind: "upload", name: original.name, file: original }, { kind: "upload", name: other.name, file: other }]);
    const items = () => editor.rows("images")[ID].items, first = items()[1];
    assertEquals(items().length, 3);
    const seen = [];
    for (let turn = 0; turn < 4; turn++) {
      assert(await editor.rotateImage(ID, editor.rows("images")[ID].images[1], "cw"));
      seen.push(items()[1].name);
      assertEquals(items()[2].file, other); assertEquals(items().length, 3);
    }
    assertEquals(seen, ["photo_r90.png", "photo_r180.png", "photo_r270.png", "photo.jpg"]);
    assertEquals(items()[1], first); assertStrictEquals(items()[1].file, original);
    assert(rotations.every(call => call.blob === original), "every angle encodes the ORIGINAL bytes");
    assertEquals(rotations.map(call => call.degrees), [90, 180, 270]);
  } finally { editor.dispose(); }
});

Deno.test("rotation: cw then ccw restores the original; a repeated angle reuses its File", async () => {
  const { editor, rotations } = await rig();
  try {
    editor.setEnabled(ID, true);
    const original = new File(["pixels"], "photo.png");
    editor.addImages(ID, [{ kind: "upload", name: original.name, file: original }]);
    const tile = () => editor.rows("images")[ID].images[1], item = () => editor.rows("images")[ID].items[1];
    await editor.rotateImage(ID, tile(), "cw");
    const r90 = item().file;
    assertEquals([r90.name, await r90.text()], ["photo_r90.png", "pixels @90"]);
    await editor.rotateImage(ID, tile(), "ccw");
    assertStrictEquals(item().file, original);
    await editor.rotateImage(ID, tile(), "cw");
    assertStrictEquals(item().file, r90);
    await editor.rotateImage(ID, tile(), "ccw"); await editor.rotateImage(ID, tile(), "ccw");
    assertEquals(item().name, "photo_r270.png");
    assertEquals(rotations.map(call => call.degrees), [90, 270]);
  } finally { editor.dispose(); }
});

Deno.test("rotation: a recorded reference reads its source bytes once and returns to the exact reference", async () => {
  const { editor, reads, origin } = await rig("nested/a.png [input]");
  try {
    editor.setEnabled(ID, true);
    const reference = editor.rows("images")[ID].items[0];
    assertEquals(reference, { kind: "reference", value: "nested/a.png [input]" });
    await editor.rotateImage(ID, editor.rows("images")[ID].images[0], "ccw");
    const rotated = editor.rows("images")[ID].items[0];
    assertEquals([rotated.kind, rotated.name, await rotated.file.text()], ["upload", "a_r270.png", "bytes of nested/a.png @270"]);
    await editor.rotateImage(ID, editor.rows("images")[ID].images[0], "ccw");
    await editor.rotateImage(ID, editor.rows("images")[ID].images[0], "cw");
    await editor.rotateImage(ID, editor.rows("images")[ID].images[0], "cw");
    assertEquals(editor.rows("images")[ID].items[0], reference);
    assertEquals(reads, [{ source: origin, name: "nested/a.png", root: "input" }]);
  } finally { editor.dispose(); }
});

Deno.test("rotation: turns requested while encoding join; the Current image is not rotatable", async () => {
  const { editor, rotations, control } = await rig();
  try {
    editor.setEnabled(ID, true);
    const original = new File(["pixels"], "photo.png");
    editor.addImages(ID, [{ kind: "upload", name: original.name, file: original }]);
    let release; control.hold = new Promise(resolve => { release = resolve; });
    const tile = editor.rows("images")[ID].images[1];
    const first = editor.rotateImage(ID, tile, "cw"), second = editor.rotateImage(ID, tile, "cw");
    assert(editor.rows("images")[ID].images[1].rotating);
    release(); control.hold = null;
    assertEquals(await Promise.all([first, second]), [true, true]);
    assertEquals(editor.rows("images")[ID].items[1].name, "photo_r180.png");
    assertEquals(rotations.map(call => call.degrees), [90, 180]);
    assert(!editor.rows("images")[ID].images[1].rotating);
    editor.toggleTargetImage(ID);
    const target = editor.rows("images")[ID].images.find(image => image.kind === "target");
    assert(!target.rotatable);
    assertEquals(await editor.rotateImage(ID, target, "cw"), false);
  } finally { editor.dispose(); }
});

Deno.test("rotation: a failed encode keeps the image and reports a field problem", async () => {
  const { editor, control } = await rig();
  try {
    editor.setEnabled(ID, true);
    const original = new File(["pixels"], "photo.png");
    editor.addImages(ID, [{ kind: "upload", name: original.name, file: original }]);
    control.fail = "decode failed";
    assertEquals(await editor.rotateImage(ID, editor.rows("images")[ID].images[1], "cw"), false);
    assertStrictEquals(editor.rows("images")[ID].items[1].file, original);
    const problem = editor.problems().find(problem => problem.code === "rotation-failed");
    assertEquals(problem.message, "Could not rotate photo.png in " + problem.parameter.label + ": decode failed. The image is unchanged.");
    control.fail = null;
    assert(await editor.rotateImage(ID, editor.rows("images")[ID].images[1], "cw"));
    assert(!editor.problems().some(problem => problem.code === "rotation-failed"));
  } finally { editor.dispose(); }
});
