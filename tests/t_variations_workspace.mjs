import { assert, assertEquals } from "jsr:@std/assert";
import { makeVariationWorkspaces } from "../client-solid/features/variations/workspaces.js";
import { makeVariationEditor } from "../client-solid/features/variations/editor.js";
import { targetRunPlan } from "../src/features/variations/shared.mjs";
import { editorRig } from "./helpers/variation-editor.mjs";

Deno.test("workspace: accepted dormant recipe recovers at the editor consumer with the exact Files, including A-B-A", async () => {
  const registry = makeVariationWorkspaces(), rig = editorRig();
  const targets = [{ id: "fake:image.png", host: "fake", filename: "image.png", origin: rig.context.origin }];
  const a = registry.open(targets), file = new File(["opaque"], "same.png");
  let inspections = 0;
  const inspect = rig.services.inspectImage;
  const services = { ...rig.services, inspectImage: (...args) => { inspections++; return inspect(...args); } };
  const mount = workspace => {
    const before = workspace.recipe.row("naming", "root")?.values.suffix;
    const editor = makeVariationEditor({ targets: workspace.targets, recipe: workspace.recipe,
      services, currentOrigin: () => rig.context.origin, setTimer: () => 1, clearTimer() {} });
    if (before !== undefined) assertEquals(editor.naming("suffix"), before);
    editor.installCatalogue(rig.catalogue); editor.installInputs({ origin: rig.context.origin, files: [] });
    return editor;
  };
  let editor = mount(a);
  editor.edit("numeric", "n.steps", "rawIncrement", "1e");
  editor.addImages("image.image", [{ kind: "upload", name: file.name, file }]);
  editor.edit("enums", "choice.value", "picks", ["second"]);
  editor.template("text.text", "dormant", "one; two");
  assertEquals((await editor.run()).adopted, true);
  assertEquals(a.recipe.acceptance().revision, a.recipe.revision());
  assertEquals(a.recipe.acceptance().plans.length, 1);
  assertEquals(a.recipe.acceptance().effects.targets.length, 1);
  assertEquals(editor.remaining(), []); editor.dispose();
  const previousInspections = inspections;
  const b = registry.open([{ ...targets[0], id: "fake:other.png", filename: "other.png" }]);
  assert(b !== a); assert(registry.open(targets) === a);
  editor = mount(registry.open(targets));
  await editor.inspectImages(); assertEquals(inspections, previousInspections + 1);
  assertEquals(editor.rows("numeric")["n.steps"].rawIncrement, "1e");
  assertEquals(editor.rows("texts")["text.text"].tpl.dormant, "one; two");
  assertEquals(editor.rows("enums")["choice.value"].picks, ["second"]);
  assert(editor.rows("images")["image.image"].items[0].file === file);
  assertEquals(editor.remaining(), []); editor.dispose(); rig.editor.dispose(); registry.dispose();
});

Deno.test("workspace: changed origins recover separately without retarget, removal and disposal release the registry", () => {
  const registry = makeVariationWorkspaces(), origin = { source: "fake", address: "one", kind: "comfy", epoch: "e", incarnation: "i" };
  const targets = [{ id: "fake:a.png", host: "fake", filename: "a.png", origin }];
  const original = registry.open(targets);
  const replacement = [{ ...targets[0], origin: { ...origin, incarnation: "new" } }];
  assert(registry.open(replacement) === original);
  assertEquals(registry.options(replacement).length, 1);
  assertEquals(original.targets[0].origin.incarnation, "i");
  const fresh = registry.fresh(replacement);
  assert(fresh !== original); assert(registry.open(replacement) === fresh);
  assertEquals(registry.options(replacement).length, 2);
  registry.remove(original); assertEquals(registry.options(replacement).length, 1);
  let retired = 0; registry.lease(() => retired++);
  registry.dispose(); assertEquals(registry.options(replacement), []); assertEquals(retired, 1);
});

Deno.test("target plan: heterogeneous relative numeric absence is explicit, other operations stay applicable", () => {
  const rig = editorRig(), payload = { relative: true, ranges: { "missing.value": { enabled: true, min: -1, max: 1, increment: 1, clamp: [0, 10] }, "n.denoise": { enabled: false } }, imageParams: { "text.text": { enabled: true, values: ["next"] } }, prefix: "", suffix: "" };
  const plan = targetRunPlan(payload, rig.catalogue);
  assertEquals(plan.operations.find(operation => operation.parameter === "missing.value").disposition, "absent-relative-numeric");
  assertEquals(plan.payload.ranges, { "n.denoise": { enabled: false } });
  assertEquals(plan.operations.find(operation => operation.parameter === "text.text").disposition, "apply");
  assertEquals(payload.ranges["missing.value"].enabled, true); rig.editor.dispose();
});
