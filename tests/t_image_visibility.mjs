import { assertEquals } from "jsr:@std/assert";
import { judgmentVisible, compileVisibility, inFolder } from "../client/js/image-visibility-model.mjs";

Deno.test("visibility: judgment precedence across vote, hiding, reveal and down override", () => {
  for (const vote of [undefined, "up", "down"]) for (const downvoteHides of [true, false])
    for (const revealThumbedDown of [true, false]) for (const hideUp of [true, false]) for (const downOverride of [true, false]) {
      const judgment = Object.freeze({ vote, favorite: true, bookmark: true });
      const prefs = Object.freeze({ downvoteHides, revealThumbedDown, hideUp });
      const expected = vote === "up" ? !hideUp : vote !== "down" || !downvoteHides || revealThumbedDown || downOverride;
      assertEquals(judgmentVisible(judgment, prefs, { downOverride }), expected, JSON.stringify({ vote, ...prefs, downOverride }));
    }
  assertEquals(judgmentVisible({ vote: "down" }), false);
  assertEquals(judgmentVisible(null), true);
});

Deno.test("visibility: folder segments, filter AND/OR and down override compose without mutation", () => {
  const down = Object.freeze({ filename: "a/deep/down.png", judgment: Object.freeze({ vote: "down", favorite: true }) });
  const up = { filename: "a/up.png", judgment: { vote: "up" } };
  for (const mode of ["and", "or"]) {
    const filter = Object.freeze({ mode, down: true, filename: "missing" });
    assertEquals(compileVisibility({ filter, folder: "a" })(down), mode === "or");
    assertEquals(compileVisibility({ filter, folder: "ab" })(down), false);
    assertEquals(compileVisibility({ prefs: { hideUp: true }, filter: { mode, down: true, up: true } })(up), false);
  }
  assertEquals(compileVisibility({ filter: { favorite: true } })(down), false, "favorite cannot reveal a downvote");
  assertEquals(compileVisibility({ prefs: { revealThumbedDown: true }, folder: "a" })(down), true);
  assertEquals(["a/x.png", "a/deep/x.png", "ab/x.png", "a.png"].map(name => inFolder(name, "a")), [true, true, false, false]);
  assertEquals(inFolder("root.png", ""), true);
});

Deno.test("visibility: unknown metadata stays unknown and incomplete filters do not contribute", () => {
  const entry = { filename: "a.png", judgment: null, meta: null };
  assertEquals(compileVisibility({ filter: { parameter: "T.seed" } })(entry), false);
  assertEquals(compileVisibility({ filter: { parameter: "T.seed", parameterMode: "equals", parameterValue: "" } })(entry), true);
  assertEquals(compileVisibility({ filter: { mode: "or", filename: "a", parameter: "T.seed" } })(entry), true);
});
