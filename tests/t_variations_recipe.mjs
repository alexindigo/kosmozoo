import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import { makeVariationRecipe, recipeDispositions } from "../client-solid/features/variations/recipe.js";

Deno.test("recipe owner: raw resources survive snapshots and a captured checkpoint never rewrites live values", () => {
  const recipe = makeVariationRecipe(), file = new File(["native"], "same.png");
  recipe.seed("images", "i.image", {}, { enabled: false, items: [] });
  recipe.write("images", "i.image", "items", [{ kind: "upload", name: file.name, file }]);
  recipe.edited();
  const captured = recipe.capture();
  assert(captured.images["i.image"].values.items[0].file === file);
  assertEquals(recipe.checkpoint(captured, 1), true);
  assertEquals(recipe.remaining(), []);
  recipe.write("images", "i.image", "enabled", true); recipe.edited();
  assertEquals(recipe.checkpoint(captured, 1), false);
  assertEquals(recipe.row("images", "i.image").values.enabled, true);
  assertEquals(recipe.remaining(), [{ domain: "images", id: "i.image", field: "enabled" }]);
  assertEquals(recipe.revision(), 2);
});

Deno.test("recipe plan: every leaf and dormant map entry has exactly one disposition; presentation and unknown fields reject", () => {
  const recipe = makeVariationRecipe();
  recipe.seed("texts", "t.text", {}, { enabled: true, text: "{{used}}", tpl: { used: "a; b", dormant: "keep me" } });
  const snapshot = recipe.capture(), binding = (name, label) => ({ channel: "imageParams", id: "t.text", path: ["texts", "t.text", name, ...(label ? [label] : [])] });
  const dispositions = recipeDispositions(snapshot, [binding("enabled"), binding("text"), binding("tpl", "used")]);
  assertEquals(dispositions.map(value => [value.path, value.disposition]), [
    [["texts", "t.text", "enabled"], "active"], [["texts", "t.text", "text"], "active"],
    [["texts", "t.text", "tpl", "used"], "active"], [["texts", "t.text", "tpl", "dormant"], "retained"],
  ]);
  assertThrows(() => recipe.write("enums", "e.value", "filter", "query"), Error, "Unclassified");
  snapshot.texts["t.text"].values.unknown = "unclassified";
  assertThrows(() => recipeDispositions(snapshot, []), Error, "Unclassified");
  delete snapshot.texts["t.text"].values.unknown;
  assertThrows(() => recipeDispositions(snapshot, [binding("enabled"), binding("enabled")]), Error, "Overlapping");
  assertThrows(() => recipeDispositions(snapshot, [binding("enabled"), binding("text")]), Error, "Unclassified active");
});
