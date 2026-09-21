// tests/t_variations_template.mjs — {{label}} substitution axes inside text
// sweeps: label detection, semicolon parsing (empties kept), cartesian
// per-line expansion.

import { assertEquals } from "jsr:@std/assert";
import {
  templateLabels, parseSemicolonList, expandTextAxes, textLines,
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

Deno.test("textLines: one value per line, blanks dropped", () => {
  assertEquals(textLines("a\n\n b \n"), ["a", "b"]);
});

Deno.test("expandTextAxes: plain lines pass through unchanged", () => {
  assertEquals(expandTextAxes("a portrait\na house"), ["a portrait", "a house"]);
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

Deno.test("expandTextAxes: per-line expansion — a line without placeholders contributes itself", () => {
  assertEquals(
    expandTextAxes("a {{animal}}\na house", { animal: ["cat", "dog"] }),
    ["a cat", "a dog", "a house"],
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
  // even plain lines drop out while a label is unconfigured
  assertEquals(expandTextAxes("plain line\n{{a}}", {}), []);
});
