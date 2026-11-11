import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import { makeVariationRecipe } from "../client-solid/features/variations/recipe.js";
import { encodeHistoryRecipe, decodeHistoryRecipe } from "../src/features/variations/history-codec.mjs";
import { compileRecipe } from "../src/features/variations/recipe-compile.mjs";
import { snapshotDraft, sameDraft, numericText, imageIdentity } from "../src/features/variations/recipe-model.mjs";
import { parseExactJson, stringifyExactJson } from "../src/parameters.mjs";

function rawRecipe() {
  const r = makeVariationRecipe();
  r.seed("naming", "root", {}, { prefix: "  exact_", suffix: "_{n.seed}" });
  r.seed("numeric", "n.seed", { id: "n.seed", nodeIds: ["n"], key: "seed", current: 9007199254740993n, label: "Seed", minIncrement: 1, defaultIncrement: 1, clamp: [0, 18446744073709551615n] },
    { enabled: true, mode: "value", min: "1e", max: " 9007199254740993 ", rawIncrement: ".", value: "18446744073709551615" });
  r.seed("texts", "n.text", { label: "Text" }, { enabled: false, text: "  multi\n\nline  ", tpl: { unused: " x;y " } });
  r.seed("candidates", "n.value", { label: "Value" }, { enabled: false, candidates: ['{ "incomplete":', 'false', 'null', '[9007199254740993]'] });
  r.seed("images", "i.image", { label: "Image" }, { enabled: false, items: [] });
  return r;
}
Deno.test("history boundary retains exact raw fields, native File identity and all ordered resources", () => {
  const r = rawRecipe(), id = crypto.randomUUID();
  const files = Array.from({ length: 80 }, (_, index) => new File([String(index)], "same.png"));
  r.write("images", "i.image", "items", files.map(file => ({ kind: "upload", name: file.name, file })));
  const snapshot = r.capture(), capture = encodeHistoryRecipe(snapshot, id);
  assertEquals(capture.files.size, 80);
  for (let i = 0; i < 80; i++) assert(capture.files.get(`image-${i}`) === files[i]);
  assert(snapshot.images["i.image"].values.items[0].file === files[0]);
  assert(sameDraft(snapshot, snapshotDraft(snapshot)));
  const restored = decodeHistoryRecipe(parseExactJson(stringifyExactJson({ format: 1, recipe: capture.recipe })));
  assertEquals(restored.numeric, snapshot.numeric);
  assertEquals(restored.texts, snapshot.texts);
  assertEquals(restored.candidates, snapshot.candidates);
  assertEquals(restored.images["i.image"].values.items.length, 80);
  assertEquals(new Set(restored.images["i.image"].values.items.map(imageIdentity)).size, 80);
  assertEquals(numericText(restored.numeric["n.seed"].values.value), 18446744073709551615n);
});
Deno.test("history boundary rejects foreign fields, versions, native/cyclic data and getters before activation", () => {
  const snapshot = rawRecipe().capture(), id = crypto.randomUUID();
  assertThrows(() => encodeHistoryRecipe({ ...snapshot, widgets: {} }, id));
  let called = false;
  Object.defineProperty(snapshot.texts["n.text"].values, "text", { enumerable: true, get() { called = true; return "bad"; } });
  assertThrows(() => encodeHistoryRecipe(snapshot, id));
  assertEquals(called, false);
  assertThrows(() => decodeHistoryRecipe({ format: 2, recipe: {} }));
  const cyclic = rawRecipe().capture(); cyclic.texts["n.text"].metadata.self = cyclic;
  assertThrows(() => encodeHistoryRecipe(cyclic, id));
});
Deno.test("shared recipe compiler retains exact Value writes, raw buffers and exhaustive dispositions", () => {
  const r = rawRecipe(), snapshot = r.capture();
  const result = compileRecipe(snapshot, { catalogue: { params: [snapshot.numeric["n.seed"].metadata] }, target: { filename: "target.png" } });
  assertEquals(result.payload.ranges["n.seed"].min, 18446744073709551615n);
  assertEquals(result.bindings.find(b => b.path.at(-1) === "value").value, "18446744073709551615");
  assert(result.dispositions.some(d => d.path.at(-1) === "rawIncrement" && d.disposition === "retained"));
  assertEquals(r.capture(), snapshot);
});
