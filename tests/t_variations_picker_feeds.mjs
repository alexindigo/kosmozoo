import { assert, assertEquals } from "jsr:@std/assert";
import { editorRig } from "./helpers/variation-editor.mjs";
import { makeVariationEditor } from "../client-solid/features/variations/editor.js";
import { makeRouter } from "../src/routes.mjs";
import { resourceReference, resourceReferenceValue } from "../src/parameters.mjs";
const id = "image.image";
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

Deno.test("picker feeds: generated references remain concrete, nested, independent of input and upload-free through Run", async () => {
  const rig = editorRig(), { editor, context } = rig;
  editor.setEnabled(id, true);
  await editor.toggleSourceInput(id, context.origin, "dir/a.png", "output");
  await editor.toggleSourceInput(id, context.origin, "dir/a.png", "input");
  assertEquals(editor.rows("images")[id].items.map(item => item.value), ["origin.png", "dir/a.png [output]", "dir/a.png"]);
  assert(editor.sourceInputState(id, context.origin, "dir/a.png", "output").selected);
  await editor.run();
  assertEquals(rig.uploads.length, 0);
  assertEquals(rig.requests[0].imageParams[id].values, ["origin.png", "dir/a.png [output]", "dir/a.png"]);
  for (const root of ["input", "output", "temp"]) for (const name of ["dir/a.png", "literal [output]"])
    assertEquals(resourceReference(resourceReferenceValue(name, root)), { name, root, annotated: root !== "input" || name.endsWith("[output]") });
  editor.dispose();
});

Deno.test("picker feeds: deferred catalogues retain exact root records, input evidence only, retry, replacement and disposal fences", async () => {
  const rig = editorRig(), { editor, context } = rig, pending = [];
  rig.services.inputList = (_host, origin, root) => { const wait = deferred(); pending.push({ ...wait, origin, root }); return wait.promise; };
  const input = editor.loadSourceInputs(context.origin, true), output = editor.loadSourceInputs(context.origin, false, "output");
  pending[1].resolve({ origin: context.origin, root: "output", files: ["nested/same.png"] }); await output;
  assertEquals(editor.rows("images")[id].files, ["origin.png", "next.png"]);
  pending[0].resolve({ origin: context.origin, root: "input", files: ["same.png"] }); await input;
  assertEquals(editor.sourceInputs(context.origin, "output").files, ["nested/same.png"]);
  assertEquals(editor.rows("images")[id].files, ["same.png"]); assert(!editor.dirty());
  const fail = editor.loadSourceInputs(context.origin, true, "output"); pending[2].reject(new Error("offline")); await fail;
  assert(editor.sourceInputs(context.origin, "output").error.includes("offline"));
  const retry = editor.loadSourceInputs(context.origin, true, "output"); pending[3].resolve({ origin: context.origin, root: "input", files: ["wrong.png"] }); await retry;
  assert(editor.sourceInputs(context.origin, "output").error.includes("Source-bound"));
  const late = editor.loadSourceInputs(context.origin, true, "output"); rig.replaceSource(); pending[4].reject(new Error("retired")); await late;
  assert(!editor.sourceInputs(context.origin, "output").error.includes("retired"));
  editor.dispose();
});

Deno.test("picker feeds: foreign byte cache binds origin/root/raw name and captured selections survive visible catalogue changes", async () => {
  const rig = editorRig(); rig.editor.dispose();
  let other = { ...rig.context.origin, source: "other" }, pending = [];
  const editor = makeVariationEditor({ targets: [{ id: "fake:image.png", host: "fake", filename: "image.png", origin: rig.context.origin }],
    services: { ...rig.services, readInput: (origin, name, root) => { const wait = deferred(); pending.push({ ...wait, origin, name, root }); return wait.promise; },
      inputList: async (_host, origin, root) => ({ origin, root, files: ["same.png"] }) }, currentOrigin: host => host === "other" ? other : rig.context.origin });
  editor.installCatalogue(rig.catalogue);
  const output = editor.toggleSourceInput(id, other, "dir/same.png", "output");
  await editor.loadSourceInputs(other, false, "input");
  const input = editor.toggleSourceInput(id, other, "dir/same.png", "input");
  assertEquals(pending.map(row => row.root), ["output", "input"]);
  pending[0].resolve(new File(["output bytes"], "dir/same.png")); await output;
  pending[1].resolve(new File(["input bytes"], "dir/same.png")); await input;
  const files = editor.rows("images")[id].items.filter(item => item.file).map(item => item.file);
  assertEquals(await Promise.all(files.map(file => file.text())), ["output bytes", "input bytes"]);
  const old = other, late = editor.toggleSourceInput(id, other, "late.png", "output");
  other = { ...other, incarnation: "new" }; await editor.loadSourceInputs(other, false, "output");
  other = old; await editor.loadSourceInputs(other, false, "output");
  // A fresh read record for A retires the old A byte flight after A/B/A.
  const replacement = editor.toggleSourceInput(id, other, "new.png", "output");
  pending[2].resolve(new File(["late"], "late.png")); await late;
  pending[3].resolve(new File(["new"], "new.png")); await replacement;
  assert(!editor.rows("images")[id].items.some(item => item.name === "late.png"));
  assert(editor.sourceInputState(id, other, "new.png", "output").selected);
  const decision = editor.toggleSourceInput(id, other, "decision.png", "output");
  editor.decision(true); editor.decision(false);
  pending[4].resolve(new File(["decision"], "decision.png")); await decision;
  assert(!editor.rows("images")[id].items.some(item => item.name === "decision.png"));
  editor.dispose();
});

Deno.test("picker feeds API: opt-in images-v1 preserves legacy shapes and fences origins before/after listing", async () => {
  const origin = { source: "c", address: "fake:8188", kind: "comfy", epoch: "e", incarnation: "i" };
  let current = origin, reads = 0, gate = null;
  const files = ["nested/a.png", "movie.mp4", "sound.wav", "hidden.png", "gone.png"].map(name => ({ name, size: 1 }));
  const inventory = Object.assign(async () => { reads++; if (gate) await gate.promise; return { items: files }; }, { capture: () => current, isCurrent: token => token === current });
  const router = makeRouter({ hosts: { c: origin.address }, inventory,
    sourceActivity: { source: () => ({ ...current, sourceVersion: { epoch: current.epoch, incarnation: current.incarnation } }) },
    backings: { backingFor: () => ({ list: async () => { reads++; if (gate) await gate.promise; return files; } }) },
    store: { entriesForCollection: () => [{ name: "hidden.png", hidden: 1 }, { name: "gone.png", state: "gone" }], arrivals: { inventory: () => null } } });
  const get = (query, expected = origin) => router.handle(new Request(`http://x/api/collections/c/entries?${query}`, { headers: expected ? { "X-Kosmozoo-Origin": JSON.stringify(expected) } : {} }));
  for (const kind of ["input", "output"]) {
    const response = await get(`kind=${kind}&catalogue=images-v1`); assertEquals(response.status, 200);
    const data = await response.json(); assertEquals([data.origin, data.root], [origin, kind]);
    assertEquals(data.files.map(row => row.name), kind === "input" ? ["nested/a.png", "hidden.png", "gone.png"] : ["nested/a.png"]);
  }
  assert(Array.isArray(await (await get("kind=output")).json()));
  assert(Array.isArray((await (await get("inventory=1")).json()).entries));
  assert(Array.isArray(await (await get("kind=input", null)).json()));
  assertEquals(Object.keys(await (await get("kind=input")).json()), ["files", "origin"]);
  for (const kind of ["temp", "wrong", ""]) assertEquals((await get(`kind=${kind}&catalogue=images-v1`)).status, 400);
  assertEquals((await get("kind=output&catalogue=images-v1", null)).status, 400);
  assertEquals((await router.handle(new Request("http://x/api/collections/c/entries?catalogue=images-v1", { headers: { "X-Kosmozoo-Origin": "malformed" } }))).status, 400);
  const before = reads;
  assertEquals((await get("kind=output&catalogue=images-v1", { ...origin, incarnation: "bad" })).status, 412); assertEquals(reads, before);
  for (const kind of ["input", "output"]) {
    gate = deferred(); const pending = get(`kind=${kind}&catalogue=images-v1`);
    current = { ...origin, incarnation: "replacement" }; gate.resolve();
    assertEquals((await pending).status, 412); current = origin; gate = null;
  }
});

Deno.test("picker feeds: catalogue A/B/A and disposal retire success, failure and finally publication for every root", async () => {
  for (const root of ["input", "output"]) {
    const rig = editorRig(); rig.editor.dispose();
    const a = rig.context.origin, b = { ...a, incarnation: "b" }, waits = [];
    let origin = a, changes = 0;
    const editor = makeVariationEditor({ targets: [{ id: "fake:image.png", host: "fake", filename: "image.png", origin: a }],
      currentOrigin: () => origin, changed: () => changes++, services: { ...rig.services,
        inputList: (_host, origin, root) => { const wait = deferred(); waits.push({ ...wait, origin, root }); return wait.promise; } } });
    editor.installCatalogue(rig.catalogue);
    const first = editor.loadSourceInputs(a, false, root);
    origin = b; const middle = editor.loadSourceInputs(b, false, root);
    origin = a; const last = editor.loadSourceInputs(a, false, root);
    const before = changes;
    waits[0].resolve({ origin: a, root, files: ["old.png"] }); await first;
    waits[1].reject(new Error("retired")); await middle;
    assertEquals(changes, before); assert(editor.sourceInputs(a, root).pending);
    waits[2].resolve({ origin: a, root, files: ["new.png"] }); await last;
    assertEquals(editor.sourceInputs(a, root).files, ["new.png"]); assert(!editor.dirty());
    const disposed = editor.loadSourceInputs(a, true, root); editor.dispose(); const retired = changes;
    waits[3].resolve({ origin: a, root, files: ["disposed.png"] }); await disposed;
    assertEquals(changes, retired);
  }
});
