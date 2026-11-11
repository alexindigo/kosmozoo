import { assert, assertEquals } from "jsr:@std/assert";
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
