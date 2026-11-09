import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import { editorRig } from "./helpers/variation-editor.mjs";
import { graphParameters } from "../src/parameters.mjs";
import { makeVariationRecipe, recipeDispositions } from "../client-solid/features/variations/recipe.js";
import { sameDraft } from "../client-solid/features/variations/draft.js";
import { numericText } from "../client-solid/features/variations/graph.mjs";

function allRig(overrides) {
  const rig = editorRig(overrides);
  const parameters = graphParameters({ custom: { class_type: "Custom", inputs: { bool: false, nil: null, object: {}, array: [], wrapper: { __value__: [false] }, text: "", seed: 18446744073709551615n, connection: ["source", 0] } }, source: { class_type: "Source", inputs: {} } });
  rig.editor.installCatalogue({ ...rig.catalogue, parameters, nodes: [{ id: "custom", type: "Custom", outputs: [{ name: "image", type: "IMAGE" }] }, { id: "source", type: "Source", outputs: [{ name: "image", type: "IMAGE" }] }] });
  return rig;
}

Deno.test("all parameters: complete unique projection starts off and retains whole raw candidates without naming rewrites", async () => {
  const rig = editorRig(), { editor, catalogue } = rig;
  const parameters = graphParameters({ custom: { class_type: "Custom", inputs: { bool: false, nil: null, object: {}, array: [], text: "", seed: 18446744073709551615n, connection: ["source", 0] } }, source: { class_type: "Source", inputs: {} } });
  editor.installCatalogue({ ...catalogue, parameters, nodes: [{ id: "custom", type: "Custom", outputs: null }, { id: "source", type: "Source", outputs: null }] });
  assertEquals(editor.catalogue().length, parameters.length);
  assert(editor.catalogue().every(row => !row.enabled));
  editor.edit("naming", "root", "suffix", "manual_{custom.bool}");
  editor.setEnabled("custom.object", true);
  editor.candidate("custom.object", 0, '{ "unfinished":');
  assertEquals(editor.preview().status, "invalid");
  assertEquals((await editor.run()).status, "invalid");
  assertEquals(rig.requests.length, 0);
  editor.setEnabled("custom.object", false); editor.setEnabled("custom.object", true);
  assertEquals(editor.rows("candidates")["custom.object"].candidates, ['{ "unfinished":']);
  assertEquals(editor.naming("suffix"), "manual_{custom.bool}");
  editor.dispose();
});

Deno.test("all parameters: exact numeric text never rounds integer bounds, Value or increments", async () => {
  const { editor, requests } = allRig();
  try {
    assertEquals(numericText("18446744073709551615"), 18446744073709551615n);
    assertEquals(numericText(" 9e-1 "), .9); assertEquals(numericText(".85"), .85);
    assertEquals(numericText("1e"), null); assertEquals(numericText("1e20"), null);
    editor.setEnabled("custom.seed", true);
    assertEquals(editor.rows("numeric")["custom.seed"].sliderSafe, false);
    editor.edit("numeric", "custom.seed", "mode", "value");
    editor.edit("numeric", "custom.seed", "value", " 18446744073709551614 ");
    assertEquals(editor.preview().n, 1);
    assertEquals((await editor.run()).adopted, true);
    assertEquals(requests[0].ranges["custom.seed"].min, 18446744073709551614n);
    assertEquals(editor.rows("numeric")["custom.seed"].value, " 18446744073709551614 ");
    editor.edit("numeric", "custom.seed", "mode", "range");
    editor.range("custom.seed", { min: "18446744073709551613", max: "18446744073709551614" });
    assertEquals(editor.preview().n, 2);
  } finally { editor.dispose(); }
});

Deno.test("all parameters: whole values dedupe only in the shared compiler, raw spelling/order stay retained", async () => {
  const { editor, requests } = allRig();
  try {
    editor.setEnabled("custom.array", true);
    editor.edit("candidates", "custom.array", "candidates", ['[false,null]', '{ "__value__": [false,null] }', '[null,false]']);
    assertEquals(editor.preview().n, 2);
    editor.moveCandidate("custom.array", 2, 0);
    await editor.run();
    assertEquals(requests[0].imageParams["custom.array"].values, [{ __value__: [null, false] }, { __value__: [false, null] }]);
    assertEquals(editor.rows("candidates")["custom.array"].candidates, ['[null,false]', '[false,null]', '{ "__value__": [false,null] }']);
    editor.setEnabled("custom.array", false); editor.installInputs({ origin: requests[0].context.origin, files: ["late.png"] }); editor.setEnabled("custom.array", true);
    assertEquals(editor.rows("candidates")["custom.array"].candidates.length, 3);
    assertEquals(requests[0].automaticNaming, true);
  } finally { editor.dispose(); }
});

Deno.test("all parameters: false, null, empty string/container and wrappers are legitimate single assignments", async () => {
  for (const [id, raw, expected] of [["bool", "false", false], ["nil", "null", null], ["object", "{}", {}], ["array", "[]", { __value__: [] }], ["wrapper", '{"__value__":[]}', { __value__: [] }]]) {
    const { editor, requests } = allRig();
    try {
      editor.setEnabled(`custom.${id}`, true); editor.candidate(`custom.${id}`, 0, raw);
      editor.setEnabled("custom.text", true); editor.edit("texts", "custom.text", "text", "changed");
      assertEquals((await editor.run()).adopted, true);
      assertEquals(requests[0].imageParams[`custom.${id}`].values, [expected]);
      editor.edit("texts", "custom.text", "text", "");
      assertEquals(editor.rows("texts")["custom.text"].text, "");
    } finally { editor.dispose(); }
  }
});

Deno.test("all parameters: known constraints and node/slot facts reject before effects, unknown schema remains editable", async () => {
  const rig = allRig(), { editor } = rig;
  try {
    const data = { ...rig.catalogue, parameters: editor.catalogue().map(row => ({ ...row, schema: row.id === "custom.bool" ? { status: "known", type: "BOOLEAN" } : row.schema })), nodes: editor.connectionNodes() };
    editor.installCatalogue(data);
    editor.setEnabled("custom.bool", true); editor.candidate("custom.bool", 0, "null");
    assertEquals(editor.preview().status, "invalid"); assertEquals((await editor.run()).status, "invalid");
    editor.setEnabled("custom.bool", false); editor.setEnabled("custom.connection", true);
    editor.connection("custom.connection", 0, "source", "1");
    assertEquals(editor.preview().status, "invalid"); assertEquals((await editor.run()).status, "invalid");
    editor.connection("custom.connection", 0, "source", "");
    assertEquals(editor.rows("candidates")["custom.connection"].candidateViews[0].slot, "");
    editor.connection("custom.connection", 0, "missing", "0"); assertEquals(editor.preview().status, "invalid");
    editor.setEnabled("custom.connection", false); editor.setEnabled("custom.object", true); editor.candidate("custom.object", 0, '{"custom":true}');
    assertEquals((await editor.run()).adopted, true); assertEquals(rig.requests.length, 1);
  } finally { editor.dispose(); }
});

Deno.test("all parameters: container kinds, candidate raw dispositions and native File identity stay distinct", () => {
  assertEquals(sameDraft([], {}), false);
  const recipe = makeVariationRecipe(); recipe.seed("candidates", "x.value", {}, { enabled: false, candidates: ['{ unfinished'] });
  const dispositions = recipeDispositions(recipe.capture(), [{ channel: "imageSelections", id: "x.value", path: ["candidates", "x.value", "enabled"] }]);
  assertEquals(dispositions.map(row => row.disposition), ["active", "retained"]);
  recipe.write("candidates", "x.value", "enabled", true);
  assertThrows(() => recipeDispositions(recipe.capture(), []), Error, "Unclassified active");
});

Deno.test("all parameters: typed option labels distinguish strings from equal-looking scalars", () => {
  const { editor, catalogue } = editorRig();
  try {
    const parameters = graphParameters({ n: { class_type: "Choice", inputs: { choice: 0 } } });
    parameters[0].schema = { status: "known", options: [0, "0", false, null] };
    editor.installCatalogue({ ...catalogue, parameters });
    assertEquals(editor.rows("candidates")["n.choice"].choices.map(choice => choice.label), ["0", '"0"', "false", "null"]);
  } finally { editor.dispose(); }
});

Deno.test("all parameters: widget safety covers exact increments as well as bounds", () => {
  const { editor } = editorRig();
  try {
    editor.setEnabled("n.steps", true);
    assertEquals(editor.rows("numeric")["n.steps"].sliderSafe, true);
    editor.edit("numeric", "n.steps", "rawIncrement", "18446744073709551615");
    assertEquals(editor.rows("numeric")["n.steps"].sliderSafe, false);
    assertEquals(editor.rows("numeric")["n.steps"].rawIncrement, "18446744073709551615");
    editor.edit("numeric", "n.steps", "rawIncrement", "1");
    assertEquals(editor.rows("numeric")["n.steps"].sliderSafe, true);
  } finally { editor.dispose(); }
});

Deno.test("all parameters: off and late input settlement retain exact native Files and manual naming", () => {
  const { editor, context } = editorRig(), file = new File(["kept"], "kept.png");
  try {
    editor.setEnabled("image.image", true);
    editor.addImages("image.image", [{ kind: "upload", name: file.name, file }]);
    editor.edit("naming", "root", "suffix", "_manual_{image.image}");
    editor.setEnabled("image.image", false);
    editor.installInputs({ origin: context.origin, files: ["late.png"] });
    assertEquals(editor.rows("images")["image.image"].enabled, false);
    editor.setEnabled("image.image", true);
    assert(editor.rows("images")["image.image"].items[0].file === file);
    assertEquals(editor.naming("suffix"), "_manual_{image.image}");
  } finally { editor.dispose(); }
});
