import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { listImages, readImage } from "../src/features/variations/folder-images.mjs";
import { editorRig } from "./helpers/variation-editor.mjs";

Deno.test("folder images: recursive image-only canonical identities, deterministic order, no symlink traversal, explicit cap", async () => {
  const dir = await Deno.makeTempDir({ prefix: "variation-folder-" });
  try {
    await Deno.mkdir(`${dir}/nested`);
    await Deno.writeTextFile(`${dir}/a.png`, "a");
    await Deno.writeTextFile(`${dir}/nested/a.png`, "b");
    await Deno.writeTextFile(`${dir}/nested/Z.JPG`, "c");
    await Deno.writeTextFile(`${dir}/nested/movie.mp4`, "not an image");
    await Deno.symlink(dir, `${dir}/nested/loop`);
    await Deno.symlink(`${dir}/a.png`, `${dir}/alias.png`);
    const result = await listImages(dir);
    assertEquals(result.items.map(item => item.path), [`${dir}/a.png`, `${dir}/nested/Z.JPG`, `${dir}/nested/a.png`]);
    assert(result.items.every(item => item.kind === "server-path"));
    assertEquals(new TextDecoder().decode((await readImage(`${dir}/a.png`)).bytes), "a");
    await assertRejects(() => listImages(dir, 2), Error, "2");
    await assertRejects(() => listImages("relative"), Error, "absolute");
    await assertRejects(() => readImage(`${dir}/alias.png`), Error, "regular");
    await assertRejects(() => readImage(`${dir}/nested/movie.mp4`), Error, "image");
  } finally { await Deno.remove(dir, { recursive: true }); }
});

Deno.test("folder images: one mixed set shares hash/count projection, actual receipts and whole-set adoption", async () => {
  const uploaded = [], rig = editorRig({
    inspectPath: async (_host, path, _current, _kind, origin) => ({ hash: (path.endsWith("current.png") ? "a" : "b").repeat(64), currentHash: "a".repeat(64), origin }),
    uploadPath: async (_host, path, hash, origin) => { uploaded.push({ path, hash }); return { name: "folder-result.png", origin }; },
  });
  const { editor } = rig, file = new File(["new"], "browser.png");
  editor.edit("numeric", "n.denoise", "enabled", false); editor.edit("images", "image.image", "enabled", true);
  const folder = { kind: "server-path", name: "folder.png", path: "/images/nested/folder.png" };
  editor.addImages("image.image", [{ kind: "input", name: "next.png" }, { kind: "upload", name: file.name, file }]);
  editor.addImages("image.image", [folder, folder, { kind: "server-path", name: "current.png", path: "/images/current.png" }]);
  await editor.inspectImages();
  assertEquals(editor.rows("images")["image.image"].items.length, 4);
  assertEquals(editor.rows("images")["image.image"].images.map(item => item.sameCurrent), [false, false, false, true]);
  assertEquals(editor.preview().n, 3); assert(editor.preview().exact);
  assertEquals((await editor.run()).submitted, 3);
  assertEquals(uploaded, [{ path: folder.path, hash: "b".repeat(64) }]);
  assertEquals(rig.requests[0].imageParams["image.image"].values, ["next.png", "browser.png", "folder-result.png", "origin.png"]);
  assert(!editor.dirty()); rig.fireTimers(); assertEquals(rig.closeCount(), 1); editor.dispose();
});

Deno.test("folder images: failed path upload never invents provenance or consumes work", async () => {
  const rig = editorRig({ inspectPath: async (_host, _path, _current, _kind, origin) => ({ hash: "b".repeat(64), currentHash: "a".repeat(64), origin }),
    uploadPath: async () => { throw new Error("Image changed since it was added"); } });
  rig.editor.edit("images", "image.image", "enabled", true);
  rig.editor.addImages("image.image", [{ kind: "server-path", name: "kept.png", path: "/images/kept.png" }]);
  const result = await rig.editor.run(); assertEquals(result.adopted, false); assert(rig.editor.dirty());
  assert(rig.editor.result().text.includes("Image changed since it was added"));
  assertEquals(rig.requests, []); assertEquals(result.submitted, 0); rig.editor.dispose();
});

Deno.test("folder images: File and distinct path identities share collision/content projection without filename-only collapse", async () => {
  const rig = editorRig({
    inspectPath: async (_host, _path, _current, _kind, origin) => ({ hash: "c".repeat(64), currentHash: "a".repeat(64), origin }),
    uploadPath: async (_host, _path, _hash, origin) => ({ name: "same (1).png", origin }),
  }), { editor } = rig;
  editor.edit("numeric", "n.denoise", "enabled", false); editor.edit("images", "image.image", "enabled", true);
  editor.addImages("image.image", [{ kind: "upload", name: "same.png", file: new File(["b"], "same.png") },
    ...["a", "b"].map(directory => ({ kind: "server-path", name: "same.png", path: `/images/${directory}/same.png` }))]);
  await editor.inspectImages(); assertEquals(editor.rows("images")["image.image"].items.length, 3);
  assertEquals(editor.preview().n, 2); assertEquals((await editor.run()).submitted, 2);
  assertEquals(rig.requests[0].imageParams["image.image"].values, ["same.png", "same (1).png"]); assert(!editor.dirty()); editor.dispose();
});

Deno.test("folder images: readding a mutable path refreshes its evidence; late foreign-source listings retain the existing set", async () => {
  let calls = 0, release;
  const rig = editorRig({
    inspectPath: async (_host, _path, _current, _kind, origin) => ({ hash: (++calls === 1 ? "a" : "b").repeat(64), currentHash: "a".repeat(64), origin }),
    listFolder: () => new Promise(resolve => { release = resolve; }),
  }), { editor } = rig;
  const item = { kind: "server-path", name: "pick.png", path: "/images/pick.png" };
  editor.addImages("image.image", [item]); await editor.inspectImages(); assert(editor.rows("images")["image.image"].images[0].sameCurrent);
  editor.removeImage("image.image", item); editor.addImages("image.image", [item]); await editor.inspectImages();
  assert(!editor.rows("images")["image.image"].images[0].sameCurrent); assertEquals(calls, 2);
  const pending = editor.addFolder("image.image", "/images"); rig.replaceSource(); release({ items: [{ ...item, path: "/elsewhere/pick.png" }] });
  await assertRejects(() => pending, Error, "editor changed"); assertEquals(editor.rows("images")["image.image"].items, [item]); editor.dispose();
});

Deno.test("folder images: later path reinspection cannot change the captured Run's receipt-backed graph value", async () => {
  let inspections = 0, release;
  const rig = editorRig({
    inspectPath: async (_host, _path, _current, _kind, origin) => ({ hash: (++inspections === 1 ? "b" : "a").repeat(64), currentHash: "a".repeat(64), origin }),
    uploadPath: (_host, _path, hash, origin) => {
      assertEquals(hash, "b".repeat(64));
      return new Promise(resolve => { release = () => resolve({ name: "captured-path.png", origin }); });
    },
  }), { editor } = rig;
  const item = { kind: "server-path", name: "mutable.png", path: "/images/mutable.png" };
  try {
    editor.edit("numeric", "n.denoise", "enabled", false); editor.edit("images", "image.image", "enabled", true);
    editor.addImages("image.image", [item]); await editor.inspectImages();
    const pending = editor.run(); while (!release) await new Promise(resolve => setTimeout(resolve, 0));
    editor.removeImage("image.image", item); editor.addImages("image.image", [item]); await editor.inspectImages();
    assert(editor.rows("images")["image.image"].images[0].sameCurrent);
    release(); const result = await pending;
    assertEquals(rig.requests[0].imageParams["image.image"].values, ["captured-path.png"]);
    assertEquals(result.adopted, false); assert(editor.dirty());
  } finally { editor.dispose(); }
});
