import { assertEquals } from "jsr:@std/assert";
import { cardState } from "../client-solid/store/card-state.js";

Deno.test("card state: one treatment supplies border and tick color, including bookmark", () => {
  const cases = [
    [{}, false, "none", "var(--focused-background)"],
    [{}, true, "current", "var(--foreground-bright)"],
    [{ bookmark: true }, false, "bookmark", "var(--primary)"],
    [{ bookmark: true }, true, "bookmark", "var(--primary)"],
    [{ vote: "up" }, true, "up", "var(--positive-dim)"],
    [{ vote: "down" }, true, "down", "var(--negative)"],
    [{ favorite: true }, true, "favorite", "var(--attention)"],
    [{ favorite: true, bookmark: true }, true, "favorite", "var(--attention)"],
    [{ vote: "up", bookmark: true }, false, "bookmark", "var(--primary)"],
  ];
  for (const [judgment, current, treatment, color] of cases) {
    const state = cardState(judgment, current);
    assertEquals(state.current, current);
    assertEquals(state.treatment, treatment);
    assertEquals(state.style["--card-color"], color);
    assertEquals(state.style["--card-glow-color"], current ? color : "var(--focused-background)");
    assertEquals(state.active.favorite, !!judgment.favorite);
    assertEquals(state.active.bookmark, !!judgment.bookmark);
    assertEquals(state.active.up, judgment.vote === "up");
    assertEquals(state.active.down, judgment.vote === "down");
  }
});

Deno.test("card state: source changes update active controls and treatment without mutating judgments", () => {
  const judgment = { bookmark: true, favorite: true, notes: { pos: "keep" } };
  const before = JSON.stringify(judgment);
  assertEquals(cardState(judgment, true).treatment, "favorite");
  assertEquals(JSON.stringify(judgment), before);
  judgment.favorite = false;
  assertEquals(cardState(judgment, true).treatment, "bookmark");
  judgment.bookmark = false;
  assertEquals(cardState(judgment, true).treatment, "current");
  assertEquals(judgment.notes, { pos: "keep" });
});

Deno.test("rail presentation: only untreated non-current fallback becomes foreground-dim", () => {
  assertEquals(cardState({}, false, { surface: "rail" }).style["--card-color"], "var(--foreground-dim)");
  assertEquals(cardState({}, false).style["--card-color"], "var(--focused-background)");
  for (const judgment of [{}, { favorite: true }, { bookmark: true }, { vote: "down" }, { vote: "up" },
    { favorite: true, bookmark: true, vote: "down" }, { bookmark: true, vote: "up" }]) {
    for (const current of [false, true]) {
      const card = cardState(judgment, current), rail = cardState(judgment, current, { surface: "rail" });
      assertEquals(rail, judgment.vote || judgment.favorite || judgment.bookmark || current ? card
        : { ...card, style: { ...card.style, "--card-color": "var(--foreground-dim)" } });
    }
  }
});
