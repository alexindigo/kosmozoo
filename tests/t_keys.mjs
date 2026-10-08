// tests/t_keys.mjs — the rebindable key registry: combo matching, overrides,
// conflicts, reset. Pure logic (no DOM).

import { assert, assertEquals } from "jsr:@std/assert";
import { bindingMatches, comboFromEvent, makeKeymap } from "../client/js/keys.mjs";

const ev = (key, mods = {}) => ({
  key,
  shiftKey: !!mods.shift, altKey: !!mods.alt, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta,
});

Deno.test("keys: bare letters ignore Shift but require no Ctrl/Alt/Meta", () => {
  assert(bindingMatches("h", ev("h")));
  assert(bindingMatches("h", ev("H", { shift: true })));  // old h/H behavior
  assert(!bindingMatches("h", ev("h", { ctrl: true })));
  assert(!bindingMatches("h", ev("x")));
});

Deno.test("keys: '?' matches Shift+/ (US layout) — e.key carries the glyph", () => {
  assert(bindingMatches("?", ev("?", { shift: true })));
});

Deno.test("keys: combo bindings match exactly (Shift+ArrowRight ≠ ArrowRight)", () => {
  assert(bindingMatches("Shift+ArrowRight", ev("ArrowRight", { shift: true })));
  assert(!bindingMatches("Shift+ArrowRight", ev("ArrowRight")));
  assert(!bindingMatches("ArrowRight", ev("ArrowRight", { shift: true })));
  assert(bindingMatches("Alt+ArrowLeft", ev("ArrowLeft", { alt: true })));
  assert(bindingMatches("Alt+Shift+ArrowLeft", ev("ArrowLeft", { alt: true, shift: true })));
  assert(!bindingMatches("Alt+Shift+ArrowLeft", ev("ArrowLeft", { alt: true })));
});

Deno.test("keys: overrides apply, rebind detects conflicts, reset restores", () => {
  let fired = 0;
  const km = makeKeymap({ describe: (id) => id, request: () => { fired++; return true; } });
  km.bind({ id: "t.action.a", key: "a", command: "test.a", desc: "A", ctx: "t" });
  km.bind({ id: "t.action.b", key: "b", command: "test.b", desc: "B", ctx: "t" });

  km.setKeymap({ "t.action.a": "Shift+F1" });
  assertEquals(km.list().find((a) => a.id === "t.action.a").key, "Shift+F1");
  assert(km.list().find((a) => a.id === "t.action.a").overridden);

  // conflict: same key, same ctx
  const c = km.rebind("t.action.b", "Shift+F1");
  assertEquals(c.conflict, "t.action.a");
  // no conflict across different ctx
  km.bind({ id: "other.action", key: "x", command: "test.x", desc: "X", ctx: "other" });
  assertEquals(km.rebind("other.action", "Shift+F1").ok, true);

  // rebind then dispatch
  assertEquals(km.rebind("t.action.a", "F2").ok, true);
  assert(bindingMatches("F2", ev("F2")));
  assertEquals(fired, 0);
  assert(km.dispatch(ev("F2")));
  assertEquals(fired, 1);

  km.resetAll();
  assertEquals(km.list().find((a) => a.id === "t.action.a").key, "a");
  assert(!km.list().find((a) => a.id === "t.action.a").overridden);
});

Deno.test("keys: comboFromEvent orders modifiers canonically", () => {
  assertEquals(comboFromEvent(ev("F5", { shift: true, ctrl: true, alt: true })), "Ctrl+Alt+Shift+F5");
  assertEquals(comboFromEvent(ev("c")), "c");
});

Deno.test("keys: findConflict treats bare letters case-insensitively", () => {
  const km = makeKeymap({ describe: (id) => id, request: () => true });
  km.bind({ id: "c.a", key: "h", command: "test.a", ctx: "c" });
  km.bind({ id: "c.b", key: "j", command: "test.b", ctx: "c" });
  assertEquals(km.findConflict("c.b", "H"), "c.a"); // "H" conflicts with "h"
  assertEquals(km.findConflict("c.b", "F9"), null);
});
