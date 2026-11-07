// tests/t_keys.mjs — the rebindable key registry: combo matching, overrides,
// conflicts, reset. Pure logic (no DOM).

import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import { bindingMatches, comboFromEvent, makeKeymap } from "../client/js/keys.mjs";
import { keyHint } from "../client-solid/lib/key-hint.js";
import { CORE_BINDINGS } from "../client-solid/store/key-bindings.js";

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

Deno.test("binding data: accessors, symbols, hidden callbacks and cycles reject without activation", () => {
  let reads = 0, described = 0;
  const km = makeKeymap({ request: () => false, describe: () => { described++; return "mode"; } });
  const base = { id: "test", key: "x", command: "workbench.mode" };
  const hidden = Object.defineProperty({ ...base }, "callback", { value() {}, enumerable: false });
  const cycle = {}; cycle.self = cycle;
  for (const binding of [
    { ...base, get args() { reads++; return { mode: "split" }; } },
    { ...base, args: { get mode() { reads++; return "split"; } } },
    { ...base, [Symbol("callback")]() {} }, hidden, { ...base, args: cycle }, { ...base, args: { ids: Array(1) } },
  ]) assertThrows(() => km.bind(binding), TypeError);
  assertEquals(reads, 0);
  assertEquals(described, 0);
  assertEquals(km.list(), []);
});

Deno.test("binding metadata: labels stay strings and invalid registration cannot become a row", () => {
  const callback = () => "executor";
  const km = makeKeymap({ request: () => false, describe: () => callback });
  assertThrows(() => km.bind({ id: "bad", key: "x", command: "known" }), TypeError);
  assertEquals(km.list(), []);
  const valid = makeKeymap({ request: () => true, describe: () => "description" });
  for (const descriptor of [
    { id: 1, key: "x", command: "known" }, { id: "bad", key: "x", command: "known", desc: [] },
    { id: "bad", key: "x", command: "known", args: [] },
  ]) assertThrows(() => valid.bind(descriptor), TypeError);
  valid.bind({ id: "valid", key: "x", command: "known", args: { mode: "split" } });
  assertEquals(valid.list()[0].desc, "description");
  assert(valid.dispatch(ev("x")));
});

Deno.test("live catalogue: installed hints follow rebinds without a static core fallback", () => {
  const dispatched = [];
  const km = makeKeymap({ describe: id => id, request: binding => { dispatched.push(binding); return true; } });
  for (const binding of CORE_BINDINGS) km.bind(binding);
  km.bind({ id: "installed.cycle", key: "a", command: "installed.alignment.cycle", ctx: "workbench" });
  assertEquals(keyHint(km.list(), "alignment", "installed.alignment.cycle"), "alignment (a)");
  assertEquals(km.rebind("installed.cycle", "v"), { ok: true });
  assertEquals(keyHint(km.list(), "alignment", "installed.alignment.cycle"), "alignment (v)");
  assertEquals(km.findConflict("wb.lock", "v"), "installed.cycle");
  assert(km.dispatch(ev("v")));
  assertEquals(dispatched.at(-1).command, "installed.alignment.cycle");
  assertEquals(keyHint(km.list(), "side", "workbench.column"), "side (ArrowLeft/Right)");
  assertEquals(keyHint(km.list(), "view", "workbench.mode", { mode: "split" }), "view (3)");
  assertEquals(keyHint(km.list(), "play", "media.toggle"), "play (Space)");
  assertEquals(keyHint([], "close", "workbench.close"), "close", "missing live entries cannot claim a static shortcut");
  km.setKeymap({ "installed.cycle": "" });
  assertEquals(keyHint(km.list(), "alignment", "installed.alignment.cycle"), "alignment");
});

Deno.test("live catalogue: nested command arguments are isolated from definitions and every snapshot", () => {
  let dispatched;
  const km = makeKeymap({ describe: () => "installed command", request: binding => { dispatched = binding; return true; } });
  const args = { nested: { items: [{ value: "original" }] } };
  km.bind({ id: "installed", key: "x", command: "installed.apply", args });
  args.nested.items[0].value = "changed original";
  const first = km.list(), second = km.list();
  assertEquals(first[0].command, "installed.apply");
  assertEquals(first[0].args.nested.items[0].value, "original");
  first[0].args.nested.items[0].value = "changed snapshot";
  first[0].command = "foreign";
  second[0].args.nested.items.push({ value: "another mutation" });
  assertEquals(km.list()[0].args, { nested: { items: [{ value: "original" }] } });
  assert(km.dispatch(ev("x")));
  assertEquals(dispatched.command, "installed.apply");
  assertEquals(dispatched.args, { nested: { items: [{ value: "original" }] } });
  const dataOnly = value => {
    assert(typeof value !== "function");
    if (value && typeof value === "object") for (const item of Object.values(value)) dataOnly(item);
  };
  dataOnly(km.list());
});
