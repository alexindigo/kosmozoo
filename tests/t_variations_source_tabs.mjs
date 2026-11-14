import { assert, assertEquals } from "jsr:@std/assert";
import { editorRig } from "./helpers/variation-editor.mjs";
import { makeVariationEditor } from "../client-solid/features/variations/editor.js";
const id = "image.image";
const sourceRig = () => {
  const rig = editorRig(); rig.editor.dispose();
  const other = { ...rig.context.origin, source: "another" };
  rig.editor = makeVariationEditor({ targets: [{ id: "fake:image.png", host: "fake", filename: "image.png", origin: rig.context.origin }],
    services: rig.services, currentOrigin: host => host === "another" ? other : rig.context.origin });
  rig.editor.installCatalogue(rig.catalogue); rig.editor.installInputs({ origin: rig.context.origin, files: ["next.png"] });
  return { ...rig, other };
};

Deno.test("source inputs: source/name cache reuses exact File across toggles, independent rows and same-named sources", async () => {
  const rig = sourceRig(), { other } = rig;
  let calls = 0;
  rig.services.readInput = async (_source, name) => { calls++; return new File(["other bytes"], name); };
  const { editor } = rig;
  await editor.toggleSourceInput(id, other, "next.png");
  const file = editor.rows("images")[id].items[1].file;
  assert(file instanceof File); assertEquals(calls, 1);
  assert(editor.sourceInputState(id, other, "next.png").selected);
  await editor.toggleSourceInput(id, other, "next.png");
  assertEquals(editor.rows("images")[id].items, [{ kind: "reference", value: "origin.png" }]);
  await editor.toggleSourceInput(id, other, "next.png");
  assert(editor.rows("images")[id].items[1].file === file); assertEquals(calls, 1);
  const second = "image.second";
  const image = rig.catalogue.parameters.find(parameter => parameter.id === id);
  editor.installCatalogue({ ...rig.catalogue, stringParams: [...rig.catalogue.stringParams,
    { ...rig.catalogue.stringParams[0], id: second, key: "second" }], parameters: [...rig.catalogue.parameters, { ...image, id: second, key: "second" }] });
  await editor.toggleSourceInput(second, other, "next.png");
  assert(editor.rows("images")[second].items[1].file === file); assertEquals(calls, 1);
  await editor.toggleSourceInput(id, rig.context.origin, "next.png");
  assertEquals(editor.rows("images")[id].items.length, 3);
  editor.removeImage(id, { kind: "upload", name: "next.png", file });
  assert(!editor.sourceInputState(id, other, "next.png").selected);
  assert(editor.sourceInputState(id, rig.context.origin, "next.png").selected);
  assert(editor.sourceInputState(second, other, "next.png").selected);
  editor.dispose();
});

Deno.test("source inputs: concurrent picks share one read, pending toggle cancels addition, failure retries and disposal fences settlement", async () => {
  const rig = sourceRig(), { editor, other } = rig;
  let resolve, calls = 0;
  rig.services.readInput = () => { calls++; return new Promise(done => resolve = done); };
  const first = editor.toggleSourceInput(id, other, "remote.png");
  assert(editor.sourceInputState(id, other, "remote.png").pending);
  await editor.toggleSourceInput(id, other, "remote.png");
  resolve(new File(["x"], "remote.png")); await first;
  assertEquals(calls, 1); assertEquals(editor.rows("images")[id].items, [{ kind: "reference", value: "origin.png" }]);
  await editor.toggleSourceInput(id, other, "remote.png");
  assertEquals(editor.rows("images")[id].items.length, 2);
  rig.services.readInput = async () => { throw new Error("byte read failed"); };
  await editor.toggleSourceInput(id, other, "retry.png");
  assert(editor.sourceInputState(id, other, "retry.png").error.includes("byte read failed"));
  rig.services.readInput = async (_source, name) => new File(["retry"], name);
  await editor.toggleSourceInput(id, other, "retry.png");
  assert(editor.sourceInputState(id, other, "retry.png").selected);
  rig.services.readInput = () => new Promise(done => resolve = done);
  const late = editor.toggleSourceInput(id, other, "late.png");
  editor.dispose(); resolve(new File(["late"], "late.png")); await late;
  assertEquals(editor.rows("images")[id].items.length, 3);
});

Deno.test("source inputs: incarnation replacement retires byte results/cache and catalogue failures remain independent of raw work", async () => {
  const rig = sourceRig(), { editor, other } = rig;
  let resolve;
  rig.services.readInput = () => new Promise(done => resolve = done);
  const late = editor.toggleSourceInput(id, other, "retired.png");
  other.incarnation = "replacement";
  resolve(new File(["retired"], "retired.png")); await late;
  assertEquals(editor.rows("images")[id].items, [{ kind: "reference", value: "origin.png" }]); assert(!editor.dirty());
  let reads = 0;
  rig.services.readInput = async (_origin, name) => { reads++; return new File(["new"], name); };
  await editor.toggleSourceInput(id, other, "retired.png"); assertEquals(reads, 1);
  const file = editor.rows("images")[id].items[1].file;
  rig.services.inputList = async () => { throw new Error("offline"); };
  await editor.loadSourceInputs(other);
  assert(editor.sourceInputs(other).error.includes("another: offline"));
  assertEquals(editor.sourceInputs(rig.context.origin).files, ["next.png"]);
  rig.services.inputList = async (_host, origin, root) => ({ origin, root, files: ["remote.png"] });
  await editor.loadSourceInputs(other, true);
  assertEquals(editor.sourceInputs(other).files, ["remote.png"]);
  assertEquals(editor.sourceInputs(other).error, "");
  assert(editor.rows("images")[id].items[1].file === file);
  editor.dispose();
});
