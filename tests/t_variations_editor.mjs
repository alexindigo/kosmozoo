import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import { EDITOR_FIELDS, makeVariationEditor } from "../client-solid/features/variations/editor.js";
import { editorRig } from "./helpers/variation-editor.mjs";
import { generatePermutations, permutationPlan } from "../src/features/variations/shared.mjs";

const cases = {
  numeric: { id: "BasicScheduler.denoise", values: { enabled: false, min: .9, max: .95, rawIncrement: "1e-1" } },
  images: { id: "LoadImage.image", values: { enabled: true, mode: "files", file: "next.png", localFiles: [new File(["a"], "a.png")] } },
  enums: { id: "Choice#choice.value", values: { enabled: true, picks: ["second"], filter: "retained" } },
  texts: { id: "Text#text.text", values: { enabled: true, text: "first\n\nsecond", tpl: { kept: "one; two" } } },
  naming: { id: "root", values: { prefix: "prefix_", suffix: "_suffix" } },
};

Deno.test("editor contract: every declared editable field participates in dirty work; unknown edits cannot create unclassified work", () => {
  for (const [domain, fields] of Object.entries(EDITOR_FIELDS)) {
    assertEquals(Object.keys(cases[domain].values), Object.keys(fields));
    for (const name of Object.keys(fields)) {
      const { editor } = editorRig(); assert(!editor.dirty());
      editor.edit(domain, cases[domain].id, name, cases[domain].values[name]);
      assert(editor.dirty(), `${domain}.${name} must register work`);
      assert(editor.remaining().some(item => item.domain === domain && item.field === name)); editor.dispose();
    }
  }
  const { editor } = editorRig();
  assertThrows(() => editor.edit("numeric", "BasicScheduler.denoise", "invented", 1)); assert(!editor.dirty());
  assertThrows(() => editor.edit("numeric", "BasicScheduler.denoise", "min", "wrong type")); assert(!editor.dirty()); editor.dispose();
});

Deno.test("editor contract: one combined configuration consumes all eligible declared fields and reaches owned closure", async () => {
  const rig = editorRig(), { editor } = rig, file = new File(["exact"], "exact.png");
  editor.range("BasicScheduler.denoise", { min: .5, max: .7 }); editor.edit("numeric", "BasicScheduler.denoise", "rawIncrement", "1e-1");
  editor.edit("images", "LoadImage.image", "enabled", true); editor.edit("images", "LoadImage.image", "mode", "files"); editor.edit("images", "LoadImage.image", "localFiles", [file]);
  editor.edit("enums", "Choice#choice.value", "enabled", true); editor.edit("enums", "Choice#choice.value", "picks", ["second", "first"]);
  editor.edit("texts", "Text#text.text", "enabled", true); editor.edit("texts", "Text#text.text", "text", "  {{used}}\n\nend\n"); editor.template("Text#text.text", "used", "one; two");
  editor.edit("naming", "root", "prefix", "combined_"); editor.edit("naming", "root", "suffix", "_complete");
  assertEquals((await editor.run()).adopted, true); assert(!editor.dirty()); assertEquals(editor.result().state, "adopted");
  assertEquals(rig.uploads.length, 1); assert(editor.rows("images")["LoadImage.image"].localFiles[0] === file);
  assertEquals(rig.requests.length, 1); assertEquals(rig.requests[0].imageParams["Text#text.text"].values, ["  one\n\nend\n", "  two\n\nend\n"]);
  assertEquals(editor.rows("numeric")["BasicScheduler.denoise"].rawIncrement, "1e-1");
  rig.fireTimers(); assertEquals(rig.closeCount(), 1); editor.dispose();
});

Deno.test("editor contract: clean metadata/default settlement during Run cannot strand captured editable work", async () => {
  let release;
  const rig = editorRig({ run: async request => {
    const response = await baseline(request); return new Promise(resolve => release = () => resolve(response));
  } });
  const baseline = editorRig().services.run, { editor } = rig;
  editor.edit("naming", "root", "prefix", "captured_"); const pending = editor.run();
  while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  editor.installInputs({ origin: rig.context.origin, files: ["new-clean-default.png", "next.png"] });
  release(); assertEquals((await pending).adopted, true); assert(!editor.dirty());
  assertEquals(editor.rows("images")["LoadImage.image"].file, "new-clean-default.png");
  rig.fireTimers(); assertEquals(rig.closeCount(), 1); editor.dispose();
});

Deno.test("editor contract: edit-and-revert, pending decisions and future-close invalidation retain their distinct fences", async () => {
  for (const transition of ["edit-revert", "pending", "keep-editing"]) {
    let release;
    const baselineRig = editorRig(), rig = editorRig({ run: async request => {
      const response = await baselineRig.services.run(request); return new Promise(resolve => release = () => resolve(response));
    } }), { editor } = rig;
    editor.edit("naming", "root", "prefix", "captured_"); const pending = editor.run();
    while (!release) await new Promise(resolve => setTimeout(resolve, 0));
    if (transition === "edit-revert") { editor.edit("naming", "root", "prefix", "newer_"); editor.edit("naming", "root", "prefix", "captured_"); }
    else { editor.invalidateClose(); editor.decision(true); if (transition === "keep-editing") editor.decision(false); }
    release(); await pending; rig.fireTimers(); assertEquals(rig.closeCount(), 0);
    assertEquals(editor.dirty(), transition !== "keep-editing");
    assert(editor.result().text.includes(transition === "pending" ? "decision pending" : transition === "edit-revert" ? "newer edits" : "submitted"));
    editor.dispose(); baselineRig.editor.dispose();
  }
});

Deno.test("editor contract: source replacement after a confirmed upload stops every unsent follow-up and keeps exact File identity", async () => {
  let release;
  const rig = editorRig({ uploadInput: async (_host, form, origin) => new Promise(resolve => release = () => resolve({ name: form.get("image").name, origin })) });
  const { editor } = rig, file = new File(["old-backend"], "same-name.png");
  editor.edit("images", "LoadImage.image", "enabled", true); editor.edit("images", "LoadImage.image", "mode", "files"); editor.edit("images", "LoadImage.image", "localFiles", [file]);
  const pending = editor.run(); while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  rig.replaceSource(); release(); assertEquals((await pending).status, "stale");
  assertEquals(rig.requests.length, 0); assert(editor.dirty()); assert(editor.rows("images")["LoadImage.image"].localFiles[0] === file);
  assert(editor.result().text.includes("origin changed")); rig.fireTimers(); assertEquals(rig.closeCount(), 0); editor.dispose();
});

Deno.test("editor contract: malformed or old proof consumes no work and performs no implicit resubmission", async () => {
  const rig = editorRig({ run: async () => ({ ok: true, status: 200, data: { submitted: 1, total: 1, errors: [] } }) });
  const { editor } = rig; editor.edit("naming", "root", "prefix", "kept_");
  await editor.run(); assert(editor.dirty()); assertEquals(editor.result().adopted, false); assert(editor.result().text.includes("acknowledgement unavailable"));
  rig.fireTimers(); assertEquals(rig.closeCount(), 0); editor.dispose();
});

Deno.test("editor contract: disposal retires a pending ticket without publishing or closing another owner", async () => {
  let release;
  const baselineRig = editorRig(), rig = editorRig({ run: async request => { const response = await baselineRig.services.run(request); return new Promise(resolve => release = () => resolve(response)); } });
  const pending = rig.editor.run(); while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  rig.editor.dispose(); release(); assertEquals((await pending).status, "stale"); rig.fireTimers(); assertEquals(rig.closeCount(), 0); baselineRig.editor.dispose();
});

Deno.test("typed permutation contract: arbitrary separators/blank strings and duplicate current values preserve field tuple identity", () => {
  for (const [current, values] of [
    [{ a: "a|b", b: "c" }, { a: ["a"], b: ["b|c"] }],
    [{ a: "\n|", b: "" }, { a: ["\n"], b: ["|"] }],
  ]) {
    const axes = Object.fromEntries(Object.entries(values).map(([id, picks]) => [id, { enabled: true, values: picks }]));
    assertEquals(generatePermutations({}, current, axes).length, 1); assertEquals(permutationPlan({}, current, axes).total, 1);
  }
  const axes = { a: { enabled: true, values: ["current", "current", "other"] } };
  assertEquals(permutationPlan({}, { a: "current" }, axes).total, 1); assertEquals(generatePermutations({}, { a: "current" }, axes), [{ a: "other" }]);
});

Deno.test("typed permutation contract: allocation-free count and generated tuples agree across range/value combinations", () => {
  for (const min of [0, .15, .5]) for (const step of [.05, .1, .2]) for (const current of [min, .2, .5]) {
    const ranges = { number: { enabled: true, min, max: .6, increment: step } }, axes = { text: { enabled: true, values: ["a|b", "a|b", ""] } };
    const values = { number: current, text: "a|b" };
    assertEquals(permutationPlan(ranges, values, axes).total, generatePermutations(ranges, values, axes).length);
  }
});

Deno.test("editor contract: initialization cannot overwrite early naming edits or manufacture work from readonly catalogue fields", async () => {
  const base = editorRig(), editor = makeVariationEditor({ targets: [{ id: 'fake:image.png', host: 'fake', filename: 'image.png', origin: base.context.origin }], services: base.services,
    currentOrigin: () => base.context.origin, setTimer: () => 0, clearTimer() {} });
  editor.edit('naming', 'root', 'prefix', 'early prefix'); editor.edit('naming', 'root', 'suffix', 'early suffix');
  editor.installCatalogue(base.catalogue); editor.installInputs({ origin: base.context.origin, files: ['origin.png'] });
  assertEquals(editor.naming('prefix'), 'early prefix'); assertEquals(editor.naming('suffix'), 'early suffix');
  assertThrows(() => editor.edit('numeric', 'BasicScheduler.denoise', 'current', 2));
  assertThrows(() => editor.edit('images', 'LoadImage.image', 'files', ['other.png']));
  assertEquals((await editor.run()).adopted, true); assert(!editor.dirty()); editor.dispose(); base.editor.dispose();
});

Deno.test("editor contract: context substitution in a correlated reply consumes no captured fields", async () => {
  const base = editorRig(), rig = editorRig({ run: async request => {
    const response = await base.services.run(request); response.data.acknowledgement.context = { ...request.context, graphHash: 'b'.repeat(64) }; return response;
  } });
  rig.editor.edit('naming', 'root', 'prefix', 'kept_'); await rig.editor.run();
  assert(rig.editor.dirty()); assertEquals(rig.editor.result().adopted, false); assert(rig.editor.result().text.includes('acknowledgement unavailable'));
  rig.fireTimers(); assertEquals(rig.closeCount(), 0); rig.editor.dispose(); base.editor.dispose();
});
