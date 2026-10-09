// tests/t_variations_template.mjs — {{label}} substitution axes inside text
// sweeps: label detection, semicolon parsing (empties kept), cartesian
// whole-template expansion.

import { assertEquals } from "jsr:@std/assert";
import {
  templateLabels, parseSemicolonList, expandTextAxes,
  generatePermutations,
} from "../src/features/variations/shared.mjs";

// --- label detection -----------------------------------------------------------

Deno.test("templateLabels: distinct labels in first-appearance order", () => {
  assertEquals(templateLabels("a {{animal}} in {{art style}} style"), ["animal", "art style"]);
  assertEquals(templateLabels("{{b}} {{a}} {{b}}"), ["b", "a"]);
  assertEquals(templateLabels("no placeholders here"), []);
  assertEquals(templateLabels("{{ }} is not a label"), []);
  assertEquals(templateLabels("{{ spaced }}"), ["spaced"]);
  assertEquals(templateLabels(null), []);
});

// --- semicolon parsing: trimmed, interior empties KEPT --------------------------

Deno.test("parseSemicolonList: empties are real values; only a blank input is unconfigured", () => {
  assertEquals(parseSemicolonList(""), []);
  assertEquals(parseSemicolonList("   "), []);
  assertEquals(parseSemicolonList("green; ; banana"), ["green", "", "banana"]);
  assertEquals(parseSemicolonList(";"), ["", ""]);
  assertEquals(parseSemicolonList(" cat ;dog "), ["cat", "dog"]);
});

// --- expansion ------------------------------------------------------------------

Deno.test("text templates: blank lines and surrounding whitespace remain literal", () => {
  assertEquals(expandTextAxes("a\n\n b \n"), ["a\n\n b \n"]);
});

Deno.test("expandTextAxes: plain multiline text passes through as one unchanged value", () => {
  assertEquals(expandTextAxes("a portrait\na house"), ["a portrait\na house"]);
});

Deno.test("expandTextAxes: an empty value substitutes the token with the empty string", () => {
  // the user's example: {{label1}} apple × "green; ; banana"
  assertEquals(
    expandTextAxes("{{label1}} apple", { label1: ["green", "", "banana"] }),
    ["green apple", " apple", "banana apple"],
  );
});

Deno.test("expandTextAxes: two labels expand cartesian-style", () => {
  assertEquals(
    expandTextAxes("{{a}} x {{b}}", { a: ["1", "2"], b: ["p", "q"] }),
    ["1 x p", "1 x q", "2 x p", "2 x q"],
  );
});

Deno.test("expandTextAxes: paragraphs without placeholders remain in every expanded whole template", () => {
  assertEquals(
    expandTextAxes("a {{animal}}\na house", { animal: ["cat", "dog"] }),
    ["a cat\na house", "a dog\na house"],
  );
});

Deno.test("expandTextAxes: every occurrence of the label is substituted", () => {
  assertEquals(expandTextAxes("{{a}} and {{a}}", { a: ["x"] }), ["x and x"]);
});

Deno.test("expandTextAxes: a label without values inerts the whole row", () => {
  assertEquals(expandTextAxes("{{a}}", {}), []);
  assertEquals(expandTextAxes("{{a}}", { a: [] }), []);
  // one configured, one not — still inert (never render a literal {{b}})
  assertEquals(expandTextAxes("{{a}} {{b}}", { a: ["x"] }), []);
  // the whole template remains inert while a referenced label is unconfigured
  assertEquals(expandTextAxes("plain line\n{{a}}", {}), []);
});

// --- sweep-to-empty: a blank text is ONE value — the empty string --------------

Deno.test("expandTextAxes: empty field is one empty value; whitespace-only text remains exact", () => {
  assertEquals(expandTextAxes(""), [""]);
  assertEquals(expandTextAxes("  \n  \n"), ["  \n  \n"]);
});

Deno.test("sweep-to-empty: empty pick vs a non-empty current is one novel permutation", () => {
  const perms = generatePermutations({}, { "CLIPTextEncode#5.text": "ugly, blurry" }, {
    "CLIPTextEncode#5.text": { enabled: true, values: [""] },
  });
  assertEquals(perms.length, 1);
  assertEquals(perms[0]["CLIPTextEncode#5.text"], "");
});

Deno.test("sweep-to-empty: empty pick vs an already-empty current is a no-op", () => {
  // sweeping "" → "" produces nothing new — the current-combo exclusion
  // drops it and the run answers 400
  const perms = generatePermutations({}, { "CLIPTextEncode#5.text": "" }, {
    "CLIPTextEncode#5.text": { enabled: true, values: [""] },
  });
  assertEquals(perms.length, 0);
});
