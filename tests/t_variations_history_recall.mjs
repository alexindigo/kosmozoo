import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { editorRig } from "./helpers/variation-editor.mjs";
import { encodeHistoryRecipe, planHistoryOverlay } from "../src/features/variations/history-codec.mjs";
import { snapshotDraft } from "../src/features/variations/recipe-model.mjs";
import { makeVariationEditor } from "../client-solid/features/variations/editor.js";
import { makeLeaveGuard } from "../client-solid/features/variations/draft.js";

async function savedRecipe(configure = () => {}) {
  let captured;
  const rig = editorRig({ history: { capture(ticket) { captured = ticket; throw new Error("captured"); }, finish() {} } });
  configure(rig.editor); await rig.editor.run();
  const id = captured.runId, encoded = encodeHistoryRecipe(captured.snapshot, id);
  const record = { id, format: 1, cohortMode: "single", recipe: encoded.recipe, leaseId: crypto.randomUUID(), resources: encoded.resources.map(resource => ({ ...resource, hash: "b".repeat(64) })) };
  rig.editor.dispose();
  return { record, raw: captured.snapshot, catalogue: rig.catalogue, context: rig.context };
}
Deno.test("history overlay: complete active ranges validate before any row patch, preserving raw Value buffers", async () => {
  const { record, raw, catalogue } = await savedRecipe(editor => {
    editor.setEnabled("n.denoise", true); editor.setEnabled("n.steps", true);
  });
  for (const cohortMode of ["single", "bulk"]) for (const values of [
    { min: "0", max: "1", rawIncrement: "0" }, { min: "0", max: "1", rawIncrement: "-1" },
    { min: "0", max: "1", rawIncrement: "0.00000001" }, { min: "1", max: "0", rawIncrement: "1" },
  ]) {
    const saved = snapshotDraft(record); saved.cohortMode = cohortMode;
    Object.assign(saved.recipe.numeric["n.denoise"].values, { mode: "range", ...values });
    const before = snapshotDraft(raw), result = planHistoryOverlay(saved, raw, [catalogue], cohortMode);
    assertEquals(result.patch.filter(p => p.id === "n.denoise"), []);
    assert(result.warnings.some(w => w.id === "n.denoise")); assertEquals(raw, before);
    assert(result.patch.some(p => p.id === "n.steps"), "compatible sibling row still applies");
  }
  const saved = snapshotDraft(record);
  Object.assign(saved.recipe.numeric["n.denoise"].values, { mode: "value", value: "0.8", min: "bad", max: "bad", rawIncrement: "0" });
  assert(planHistoryOverlay(saved, raw, [catalogue], "single").patch.some(p => p.id === "n.denoise" && p.name === "value"));
  for (const bounds of [["2", "2"], ["9007199254740993", "9007199254740994"]]) {
    const exact = snapshotDraft(record); exact.cohortMode = "bulk";
    Object.assign(exact.recipe.numeric["n.steps"].values, { mode: "range", min: bounds[0], max: bounds[1], rawIncrement: "1" });
    const result = planHistoryOverlay(exact, raw, [catalogue], "bulk");
    assertEquals(result.patch.find(p => p.id === "n.steps" && p.name === "max")?.value, bounds[1]);
  }
});
Deno.test("history overlay: active contributors only, dormant destination text/native File identity and overlap cancellation", async () => {
  const { record } = await savedRecipe(editor => {
    editor.setEnabled("n.denoise", true); editor.edit("numeric", "n.denoise", "mode", "value"); editor.edit("numeric", "n.denoise", "value", "0.8");
    editor.edit("naming", "root", "prefix", "saved_");
  });
  const rig = editorRig(), file = new File(["keep"], "keep.png");
  rig.editor.edit("numeric", "n.denoise", "min", "1e");
  rig.editor.addImages("image.image", [{ kind: "upload", name: file.name, file }]);
  rig.editor.edit("texts", "text.text", "text", "unrelated\n\ntext");
  const planned = await rig.editor.planRecall(record);
  assertEquals(planned.overlap, false);
  assertEquals(rig.editor.applyRecall(planned).status, "applied");
  assertEquals(rig.editor.rows("numeric")["n.denoise"].value, "0.8");
  assertEquals(rig.editor.rows("numeric")["n.denoise"].min, "1e");
  assertEquals(rig.editor.rows("texts")["text.text"].text, "unrelated\n\ntext");
  assert(rig.editor.rows("images")["image.image"].items[1].file === file);
  rig.editor.edit("numeric", "n.denoise", "value", "0.7");
  const next = await rig.editor.planRecall(record); assert(next.overlap);
  let decision;
  const guard = makeLeaveGuard({ dirty: intent => intent.overlap, suspend() {}, restore() {}, decision: value => { decision = value; rig.editor.decision(value); }, invalidate: rig.editor.invalidateClose });
  const pending = guard.request({ intent: { type: "apply-history", overlap: true }, permit: () => rig.editor.applyRecall(next), cancel() {} });
  assert(decision); guard.cancel(); assertEquals((await pending).status, "cancelled");
  assertEquals(rig.editor.rows("numeric")["n.denoise"].value, "0.7"); assert(rig.editor.rows("images")["image.image"].items[1].file === file);
  guard.dispose(); rig.editor.dispose();
});
Deno.test("history overlay: range basis, missing locations/type/choice and unresolved affixes warn without reinterpretation", async () => {
  const { record, raw, catalogue } = await savedRecipe(editor => {
    editor.setEnabled("n.denoise", true); editor.setEnabled("n.steps", true); editor.setEnabled("choice.value", true);
    editor.edit("enums", "choice.value", "picks", ["second"]); editor.edit("naming", "root", "suffix", "_{missing.input}");
  });
  const changed = snapshotDraft(catalogue);
  changed.parameters = changed.parameters.filter(p => p.id !== "n.steps").map(p => p.id === "choice.value" ? { ...p, type: "Different" } : p);
  const result = planHistoryOverlay(record, raw, [changed], "bulk");
  assertEquals(result.patch.length, 0);
  assertEquals(result.warnings.map(w => w.id).sort(), ["choice.value", "n.denoise", "n.steps", "suffix"]);
  assert(result.warnings.find(w => w.id === "n.denoise").reason.includes("basis"));
});
Deno.test("original restore: archived catalogue/full raw setup seeds unsent work without probe or old accepted timers", async () => {
  const { record, raw, catalogue, context } = await savedRecipe(editor => {
    editor.edit("numeric", "n.denoise", "min", "1e"); editor.setEnabled("n.denoise", true);
    editor.edit("numeric", "n.denoise", "mode", "value"); editor.edit("numeric", "n.denoise", "value", "0.8");
  });
  const target = { id: "fake:image.png", host: "fake", filename: "image.png", origin: context.origin, context, catalogue,
    historyRef: { runId: record.id, targetIndex: 0, leaseId: record.leaseId } };
  record.targets = [target]; let released = 0;
  const editor = makeVariationEditor({ targets: [target], currentOrigin: () => context.origin, services: { history: { release() { released++; return Promise.resolve(); } } } });
  editor.restoreHistory(record);
  assert(editor.ready()); assert(editor.dirty());
  assertEquals(editor.rows("numeric")["n.denoise"].min, raw.numeric["n.denoise"].values.min);
  assertEquals(editor.rows("numeric")["n.denoise"].value, "0.8");
  editor.installInputs({ origin: context.origin, files: ["new.png"] });
  assertEquals(editor.rows("numeric")["n.denoise"].min, "1e");
  editor.dispose(); assertEquals(released, 1);
});
Deno.test("history overlay: a newer revision, source replacement or disposed editor retires a prepared patch", async () => {
  const { record } = await savedRecipe(editor => { editor.setEnabled("n.denoise", true); editor.edit("numeric", "n.denoise", "mode", "value"); editor.edit("numeric", "n.denoise", "value", "0.8"); });
  for (const retire of [rig => rig.editor.edit("naming", "root", "prefix", "newer_"), rig => rig.replaceSource(), rig => rig.editor.dispose()]) {
    const rig = editorRig();
    const plan = await rig.editor.planRecall(record);
    retire(rig);
    assertEquals(rig.editor.applyRecall(plan).status, "stale");
    assertEquals(rig.editor.rows("numeric")["n.denoise"].enabled, false);
    rig.editor.dispose();
  }
});

Deno.test("history overlay: only used template labels replace destination buffers and participate in overlap", async () => {
  const { record } = await savedRecipe(editor => {
    editor.setEnabled("text.text", true);
    editor.edit("texts", "text.text", "text", "{{used}} {{__proto__}}");
    editor.edit("texts", "text.text", "tpl", JSON.parse('{"used":"saved","__proto__":"literal label","dormant":"old unused"}'));
  });
  const rig = editorRig();
  try {
    rig.editor.edit("texts", "text.text", "tpl", { dormant: "unsent buffer" });
    const first = await rig.editor.planRecall(record);
    assertEquals(first.overlap, false, "unrelated dormant edits do not require discarding work");
    assert(Object.hasOwn(first.patch.find(field => field.name === "tpl").value, "__proto__"));
    assertEquals(rig.editor.applyRecall(first).status, "applied");
    assertEquals(rig.editor.rows("texts")["text.text"].tpl, JSON.parse('{"used":"saved","__proto__":"literal label","dormant":"unsent buffer"}'));
    rig.editor.edit("texts", "text.text", "tpl", { used: "new work", dormant: "unsent buffer" });
    assert((await rig.editor.planRecall(record)).overlap, "used-label conflicts still require confirmation");
  } finally { rig.editor.dispose(); }
});

Deno.test("leave guard: applied mounted transitions resume capabilities; disposed transitions do not", async () => {
  for (const unmount of [false, true]) {
    let suspended = false, resumes = 0;
    const guard = makeLeaveGuard({ dirty: () => true, invalidate() {}, decision() {},
      suspend() { suspended = true; }, restore() { suspended = false; resumes++; } });
    const pending = guard.request({ intent: { type: "apply-history" }, cancel() {}, permit() {
      if (unmount) guard.dispose();
      return { status: "applied" };
    } });
    assert(suspended); guard.discard(); assertEquals((await pending).status, "applied");
    assertEquals(resumes, unmount ? 0 : 1);
    if (!unmount) assertEquals(suspended, false);
    guard.dispose();
  }
});

const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };
const imageId = "image.image", otherImageId = "image.second";
function acquisitionRig() {
  const rig = editorRig(); rig.editor.dispose();
  const foreign = { ...rig.context.origin, source: "other" }, reads = [], folders = [];
  rig.services.readInput = (origin, name, root) => { const wait = deferred(); reads.push({ ...wait, origin, name, root }); return wait.promise; };
  rig.services.listFolder = () => { const wait = deferred(); folders.push(wait); return wait.promise; };
  rig.services.inputList = async (_host, origin, root) => ({ origin, root, files: ["same.png"] });
  rig.editor = makeVariationEditor({ targets: [{ id: "fake:image.png", host: "fake", filename: "image.png", origin: rig.context.origin }],
    services: rig.services, currentOrigin: host => host === "other" ? foreign : rig.context.origin });
  const image = rig.catalogue.parameters.find(p => p.id === imageId);
  rig.editor.installCatalogue({ ...rig.catalogue, parameters: [...rig.catalogue.parameters, { ...image, id: otherImageId, key: "second" }] });
  return { ...rig, foreign, reads, folders };
}
const imageRecall = () => savedRecipe(editor => { editor.setEnabled(imageId, true); editor.addImages(imageId, [{ kind: "reference", value: "saved.png" }]); });

Deno.test("recall membership: foreign roots retire only replaced rows; new explicit picks share the pending validated File", async () => {
  const { record } = await imageRecall();
  for (const root of ["input", "output"]) for (const repick of [false, true]) {
    const { editor, foreign, reads } = acquisitionRig();
    try {
      const pending = editor.toggleSourceInput(imageId, foreign, "same.png", root);
      await editor.toggleSourceInput(otherImageId, foreign, "same.png", root);
      const plan = await editor.planRecall(record); assertEquals(plan.overlap, false);
      assertEquals(editor.applyRecall(plan).status, "applied");
      assertEquals(editor.sourceInputState(imageId, foreign, "same.png", root).pending, false);
      assertEquals(editor.sourceInputState(otherImageId, foreign, "same.png", root).pending, true);
      if (repick) {
        await editor.toggleSourceInput(imageId, foreign, "same.png", root);
        assert(editor.sourceInputState(imageId, foreign, "same.png", root).pending);
      }
      const file = new File([root], "same.png"); reads[0].resolve(file); await pending;
      assertEquals(editor.rows("images")[imageId].items.filter(item => item.file).length, repick ? 1 : 0);
      assert(editor.rows("images")[otherImageId].items.at(-1).file === file, "unrelated same-read choice remains live");
      if (!repick) await editor.toggleSourceInput(imageId, foreign, "same.png", root);
      assert(editor.rows("images")[imageId].items.at(-1).file === file);
      assertEquals(reads.length, 1);
    } finally { editor.dispose(); }
  }
});

Deno.test("recall membership: numeric recall, typing and catalogue browsing preserve pending choices and deselection", async () => {
  const { record } = await savedRecipe(editor => editor.setEnabled("n.steps", true));
  const empty = (await savedRecipe()).record;
  const { editor, foreign, reads } = acquisitionRig();
  try {
    const keep = editor.toggleSourceInput(imageId, foreign, "keep.png", "output");
    const cancel = editor.toggleSourceInput(imageId, foreign, "cancel.png", "input");
    await editor.toggleSourceInput(imageId, foreign, "cancel.png", "input");
    editor.edit("naming", "root", "suffix", "typing");
    await editor.loadSourceInputs(foreign, false, "input");
    assertEquals(editor.applyRecall(await editor.planRecall(record)).status, "applied");
    const revision = editor.revision();
    assertEquals(editor.applyRecall(await editor.planRecall(empty)).status, "unchanged");
    assertEquals(editor.revision(), revision);
    reads[0].resolve(new File(["keep"], "keep.png")); reads[1].resolve(new File(["cancel"], "cancel.png"));
    await Promise.all([keep, cancel]);
    assertEquals(editor.rows("images")[imageId].items.filter(item => item.file).map(item => item.name), ["keep.png"]);
  } finally { editor.dispose(); }
});

Deno.test("recall membership: folder and foreign tickets share blocking-decision and row retirement, without cancelling new picks", async () => {
  const { record } = await imageRecall();
  for (const transition of ["recall", "keep", "discard"]) {
    const { editor, foreign, reads, folders } = acquisitionRig();
    try {
      const folder = editor.addFolder(imageId, "/images");
      const unrelated = editor.addFolder(otherImageId, "/other");
      const read = editor.toggleSourceInput(imageId, foreign, "same.png");
      if (transition === "recall") editor.applyRecall(await editor.planRecall(record));
      else {
        const guard = makeLeaveGuard({ dirty: () => true, suspend() {}, restore() {}, invalidate: editor.invalidateClose, decision: editor.decision });
        const decision = guard.request({ intent: { type: "close" }, cancel() {}, permit: () => ({ status: "applied" }) });
        if (transition === "keep") guard.cancel(); else guard.discard();
        await decision; guard.dispose();
      }
      await editor.toggleSourceInput(imageId, foreign, "same.png");
      const currentFolder = editor.addFolder(imageId, "/new");
      const item = name => ({ kind: "server-path", path: `/images/${name}`, name });
      const retired = assertRejects(() => folder, Error, "editor changed");
      const otherResult = transition === "recall" ? unrelated : assertRejects(() => unrelated, Error, "editor changed");
      folders[0].resolve({ items: [item("old.png")] }); folders[1].resolve({ items: [item("other.png")] });
      folders[2].resolve({ items: [item("new.png")] });
      const file = new File(["fresh choice"], "same.png"); reads[0].resolve(file);
      await Promise.all([retired, otherResult, currentFolder, read]);
      assert(!editor.rows("images")[imageId].items.some(item => item.name === "old.png"));
      assert(editor.rows("images")[imageId].items.some(item => item.name === "new.png"));
      assert(editor.rows("images")[imageId].items.some(item => item.file === file));
      assertEquals(editor.rows("images")[otherImageId].items.some(item => item.name === "other.png"), transition === "recall");
    } finally { editor.dispose(); }
  }
});

Deno.test("empty recall: unchanged preserves raw/File identity, revision, earlier lease and accepted close timer", async () => {
  const { record } = await savedRecipe(editor => editor.setEnabled("n.steps", true));
  const incompatible = snapshotDraft(record); incompatible.recipe.numeric["missing.steps"] = incompatible.recipe.numeric["n.steps"]; delete incompatible.recipe.numeric["n.steps"];
  incompatible.leaseId = crypto.randomUUID();
  const released = [], rig = editorRig();
  try {
    rig.services.history = { release(record) { released.push(record.leaseId); return Promise.resolve(); } };
    // Acquire a previous successful recall lease, then use the legacy Run rig.
    rig.editor.applyRecall(await rig.editor.planRecall(record)); delete rig.services.history;
    const file = new File(["keep"], "keep.png"); rig.editor.addImages(imageId, [{ kind: "upload", name: file.name, file }]);
    assert((await rig.editor.run()).adopted); assert(!rig.editor.dirty());
    const revision = rig.editor.revision(), before = rig.editor.rows("images")[imageId].items;
    const plan = await rig.editor.planRecall(incompatible); assertEquals(plan.patch, []); assert(plan.warnings.length);
    assertEquals(rig.editor.applyRecall(plan), { status: "unchanged" });
    assertEquals(rig.editor.revision(), revision); assert(!rig.editor.dirty());
    assertEquals(rig.editor.rows("images")[imageId].items, before); assert(rig.editor.rows("images")[imageId].items.at(-1).file === file);
    rig.fireTimers(); assertEquals(rig.closeCount(), 1);
    rig.editor.decision(true);
    assertEquals(rig.editor.applyRecall(plan), { status: "stale" }, "the direct empty path still observes blocking-decision ownership");
    rig.editor.decision(false);
    rig.services.history = { release(record) { released.push(record.leaseId); return Promise.resolve(); } };
  } finally { rig.editor.dispose(); }
  assertEquals(released, [record.leaseId], "empty recall never transfers its new lease to the editor");
});
