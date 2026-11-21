import { assert, assertEquals } from "jsr:@std/assert";
import { editorRig } from "./helpers/variation-editor.mjs";
import { makeVariationEditor } from "../client-solid/features/variations/editor.js";

const id = "image.image";
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function rig() {
  const base = editorRig(); base.editor.dispose();
  const other = { ...base.context.origin, source: "another" }, reads = new Map();
  const services = { ...base.services, readInput: (_origin, name) => {
    const read = deferred(); reads.set(name, read); return read.promise;
  } };
  const editor = makeVariationEditor({ targets: [{ id: "fake:image.png", host: "fake", filename: "image.png", origin: base.context.origin }],
    services, currentOrigin: source => source === "another" ? other : base.context.origin });
  editor.installCatalogue(base.catalogue); editor.setEnabled(id, true);
  return { editor, other, reads, services };
}

Deno.test("picker: ten clicks select synchronously, four reads at most, out-of-order replies land in click order", async () => {
  const { editor, other, reads } = rig();
  const names = Array.from({ length: 10 }, (_, i) => `pick-${i}.png`);
  const tasks = names.map(name => {
    const task = editor.toggleSourceInput(id, other, name);
    assert(editor.sourceInputState(id, other, name).selected, "selection must precede IO");
    assert(editor.sourceInputState(id, other, name).pending);
    return task;
  });
  assertEquals(reads.size, 4);
  assert(!editor.canRun()); assertEquals((await editor.run()).status, "invalid");
  // Keep the first read held while all later reads settle in reverse waves.
  for (const group of [[3, 2, 1], [6, 5, 4], [9, 8, 7]]) {
    for (const i of group) reads.get(names[i]).resolve(new File([names[i]], names[i]));
    await tick();
  }
  assertEquals(editor.rows("images")[id].items.length, 1, "later replies await the first click");
  reads.get(names[0]).resolve(new File(["first"], names[0]));
  await Promise.all(tasks); await editor.inspectImages();
  assertEquals(editor.rows("images")[id].items.slice(1).map(item => item.name), names);
  assert(names.every(name => !editor.sourceInputState(id, other, name).pending));
  editor.dispose();
});

Deno.test("picker: cancelling and failing picks release ordered membership without disturbing siblings", async () => {
  const { editor, other, reads } = rig();
  const cancelled = editor.toggleSourceInput(id, other, "cancel.png");
  const failed = editor.toggleSourceInput(id, other, "fail.png");
  const kept = editor.toggleSourceInput(id, other, "keep.png");
  await editor.toggleSourceInput(id, other, "cancel.png");
  assert(!editor.sourceInputState(id, other, "cancel.png").selected);
  reads.get("keep.png").resolve(new File(["kept"], "keep.png")); await tick();
  reads.get("fail.png").reject(new Error("controlled byte failure")); await failed;
  assert(!editor.sourceInputState(id, other, "fail.png").selected);
  assert(editor.sourceInputState(id, other, "fail.png").error.includes("controlled byte failure"));
  assert(editor.sourceInputState(id, other, "fail.png").error.includes("fail.png"));
  reads.get("cancel.png").resolve(new File(["late"], "cancel.png"));
  await Promise.all([cancelled, kept]);
  assertEquals(editor.rows("images")[id].items.slice(1).map(item => item.name), ["keep.png"]);
  assert(editor.sourceInputState(id, other, "fail.png").error, "a sibling success cannot erase the failed tile");
  editor.dispose();
});

Deno.test("picker: Pexels shares optimistic order, queued cancellation and disposal fences", async () => {
  const { editor, other, reads, services } = rig(), photo = deferred();
  services.readPexelsPhoto = () => photo.promise;
  const first = editor.toggleSourceInput(id, other, "first.png");
  const second = editor.togglePexels(id, "service", "42", "http://photos/42");
  assert(editor.pexelsState(id, "service", "42").selected);
  photo.resolve(new File(["photo"], "photo.png")); await tick();
  assert(editor.pexelsState(id, "service", "42").pending);
  reads.get("first.png").resolve(new File(["first"], "first.png")); await Promise.all([first, second]);
  assertEquals(editor.rows("images")[id].items.slice(1).map(item => item.name), ["first.png", "photo.png"]);
  const tasks = Array.from({ length: 6 }, (_, i) => editor.toggleSourceInput(id, other, `late-${i}.png`));
  editor.dispose();
  for (const [name, read] of reads) read.resolve(new File([name], name));
  await Promise.all(tasks);
  assertEquals(reads.size, 5, "disposed queued reads never start");
});

Deno.test("picker: immediate choices retain click order around remote reservations; queued cancellation skips IO", async () => {
  const { editor, other, reads } = rig();
  const tasks = ["a.png", "b.png"].map(name => editor.toggleSourceInput(id, other, name));
  editor.addImages(id, [{ kind: "input", name: "later-local.png" }]);
  reads.get("b.png").resolve(new File(["b"], "b.png")); await tick();
  reads.get("a.png").resolve(new File(["a"], "a.png")); await Promise.all(tasks);
  assertEquals(editor.rows("images")[id].items.slice(1).map(item => item.name), ["a.png", "b.png", "later-local.png"]);
  const more = Array.from({ length: 5 }, (_, i) => editor.toggleSourceInput(id, other, `queue-${i}.png`));
  await editor.toggleSourceInput(id, other, "queue-4.png");
  for (const [name, read] of reads) read.resolve(new File([name], name));
  await Promise.all(more);
  assert(!reads.has("queue-4.png"));
  editor.dispose();
});
