import { assert, assertEquals, assertStrictEquals } from "jsr:@std/assert";
import { matchesPickerJudgments, pickerJudgments } from "../client-solid/features/variations/picker-judgments.js";
import { editorRig } from "./helpers/variation-editor.mjs";
import { judgmentVisible } from "../client/js/image-visibility-model.mjs";

const filtersFor = bits => Object.fromEntries(pickerJudgments.map(({ name }, bit) => [name, !!(bits & (1 << bit))]));
const judgmentFor = bits => ({ vote: bits & 1 ? "up" : "down", favorite: !!(bits & 2), bookmark: !!(bits & 4) });

Deno.test("picker judgments: all eight flag combinations against all eight AND filters", () => {
  for (let flags = 0; flags < 8; flags++) for (let filters = 0; filters < 8; filters++)
    assertEquals(matchesPickerJudgments(judgmentFor(flags), filtersFor(filters)), (flags & filters) === filters);
  assert(matchesPickerJudgments(null));
  for (const filter of pickerJudgments) assert(!matchesPickerJudgments(null, { [filter.name]: true }));
});

Deno.test("picker judgments: shared live projection before search, without edits, reads or input filtering", async () => {
  const votes = new Map(), prefs = { downvoteHides: true };
  let reads = 0;
  const rig = editorRig({
    inputList: async (_host, origin, root) => { reads++; return { origin, root, files: Array.from({ length: 8 }, (_, i) => ({ name: `${i}.png`, judgment: judgmentFor(i) })) }; },
    outputCandidate: (_origin, entry) => {
      const judgment = votes.get(entry.name) ?? entry.judgment;
      return { judgment, visible: judgmentVisible(judgment, prefs) };
    },
  });
  const { editor, context } = rig;
  await editor.loadSourceInputs(context.origin, false, "output");
  for (let bits = 0; bits < 8; bits++) {
    const filters = filtersFor(bits), result = editor.sourceInputs(context.origin, "output", filters);
    const expected = Array.from({ length: 8 }, (_, i) => i).filter(i => i & 1 && (i & bits) === bits).map(i => `${i}.png`);
    assertEquals(result.files, expected);
    assertEquals([...result.markers.keys()], expected);
    assertStrictEquals(editor.sourceInputs(context.origin, "output", filters).files, result.files);
  }
  votes.set("7.png", { vote: "up", favorite: false, bookmark: true });
  assertEquals(editor.sourceInputs(context.origin, "output", filtersFor(7)).files, []);
  votes.delete("7.png");
  assertEquals(editor.sourceInputs(context.origin, "output", filtersFor(7)).files, ["7.png"]);
  prefs.hideUp = true;
  assertEquals(editor.sourceInputs(context.origin, "output", filtersFor(7)).files, []);
  await editor.loadSourceInputs(context.origin, true, "input");
  assertEquals(editor.sourceInputs(context.origin, "input", filtersFor(7)).files.length, 8);
  assertEquals(reads, 2); assertEquals(editor.revision(), 0); assert(!editor.dirty());
  editor.dispose();
});
