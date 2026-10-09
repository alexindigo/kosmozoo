import { assertEquals } from "jsr:@std/assert";
import { expandTextAxes, generatePermutations } from "../src/features/variations/shared.mjs";

Deno.test("multiline text: paragraphs, indentation and whitespace are one exact literal variation", () => {
  const text = "  First paragraph.\n\nSecond paragraph.\n  Indented line.\n";
  assertEquals(expandTextAxes(text), [text]);
  assertEquals(expandTextAxes("  \n  \n"), ["  \n  \n"]);
});

Deno.test("multiline templates: labels across paragraphs expand one whole-template Cartesian product", () => {
  const text = "A {{animal}}.\n\n{{style}} style.\nAgain: {{animal}}.";
  assertEquals(expandTextAxes(text, { animal: ["cat", "dog"], style: ["oil", "", "ink"] }), [
    "A cat.\n\noil style.\nAgain: cat.", "A cat.\n\n style.\nAgain: cat.", "A cat.\n\nink style.\nAgain: cat.",
    "A dog.\n\noil style.\nAgain: dog.", "A dog.\n\n style.\nAgain: dog.", "A dog.\n\nink style.\nAgain: dog.",
  ]);
});

Deno.test("multiline current text: enabling unchanged formatted text creates no novel current permutation", () => {
  const current = "First paragraph.\n\nSecond paragraph.\n";
  const values = expandTextAxes(current);
  assertEquals(generatePermutations({}, { text: current }, { text: { enabled: true, values } }), []);
  const edited = current + "Third paragraph.";
  assertEquals(generatePermutations({}, { text: current }, { text: { enabled: true, values: expandTextAxes(edited) } }), [{ text: edited }]);
});
