import { assert, assertEquals, assertStrictEquals, assertThrows, assertRejects } from "jsr:@std/assert";
import { makeCommandHandles } from "../client-solid/store/command-handles.js";
import { makeKeymap } from "../client/js/keys.mjs";
import { makeInputPolicy } from "../client-solid/store/input-policy.js";
import { CORE_BINDINGS } from "../client-solid/store/key-bindings.js";
import { makeAppStore } from "../client-solid/store/app-store.js";
import { makeLeaveGuard, snapshotDraft, sameDraft } from "../client-solid/features/variations/draft.js";
import { makeVariationSession } from "../client-solid/features/variations/session.js";
import { variationCommands } from "../client-solid/features/variations/commands.js";
import { registerCoreCommands } from "../client-solid/store/core-commands.js";

Deno.test("commands: stable ports, original results/promises, unbound invocation and private executors", async () => {
  const handles = makeCommandHandles();
  const promise = Promise.resolve({ ok: true });
  const seen = [];
  const port = handles.register({ id: "test", description: "test port", execute: (args) => { seen.push(args); return promise; } });
  assertStrictEquals(handles.get("test"), port);
  assertStrictEquals(port.invoke({ id: "a" }), promise);
  assertStrictEquals(handles.invoke("test", { id: "b" }), promise);
  assertEquals(await promise, { ok: true });
  assertEquals(seen, [{ id: "a" }, { id: "b" }]);
  assertEquals(Object.keys(port), ["id", "description", "invoke"]);
  assertEquals(handles.list(), [{ id: "test", description: "test port" }]);
  assertThrows(() => handles.register({ id: "test", execute() {} }));
  assertThrows(() => handles.get("missing"));
});

Deno.test("commands: malformed input and event/function payloads reject before execution", () => {
  const handles = makeCommandHandles();
  let calls = 0;
  handles.register({ id: "test", validate: (a) => typeof a.id === "string", execute: () => calls++ });
  for (const payload of [null, [], { id: null }, { id: "a", fn() {} }, { id: "a", event: new Event("keydown") }, { id: "a", value: NaN }])
    assertThrows(() => handles.invoke("test", payload));
  assertEquals(calls, 0);
});

Deno.test("commands: owner cleanup is registration-specific", () => {
  const handles = makeCommandHandles();
  handles.registerOwned({ id: "local" });
  const old = handles.own("local", () => "old");
  const newer = handles.own("local", () => "new");
  old();
  assertEquals(handles.invoke("local"), "new");
  newer();
  assertEquals(handles.invoke("local"), false);
});

function inputRig() {
  const handles = makeCommandHandles(), errors = [], layers = [];
  const flags = { pair: false, open: false, panel: false, capture: null };
  const state = { diff: { get open() { return flags.open; } }, diffPair: () => ({ b: flags.pair }), keysPanelOpen: () => flags.panel, capturing: () => flags.capture };
  const policy = makeInputPolicy({ handles, state, layers: () => layers, captureEvent: () => {}, onError: (error) => errors.push(error) });
  const km = makeKeymap({ request: policy.request, describe: (id) => handles.get(id).description });
  const event = (key, tag = "div", mods = {}) => ({ key, ...mods, target: { matches: (query) => query.split(", ").includes(tag) },
    prevented: 0, stopped: 0, preventDefault() { this.prevented++; }, stopPropagation() { this.stopped++; } });
  return { handles, errors, layers, flags, policy, km, event };
}

Deno.test("keys: descriptors resolve the same port, rebind only maps input, false consumes", () => {
  const r = inputRig();
  const values = [];
  const port = r.handles.register({ id: "test", execute: (a) => { values.push(a); return false; } });
  r.km.bind({ id: "binding", key: "x", command: "test", args: { value: 1 } });
  const key = r.event("x");
  assert(r.policy.dispatch(key, r.km));
  assertEquals(key.prevented, 1);
  assertStrictEquals(r.handles.get("test"), port);
  assertEquals(r.km.rebind("binding", "y"), { ok: true });
  assert(!r.policy.dispatch(r.event("x"), r.km));
  r.policy.dispatch(r.event("y"), r.km);
  port.invoke({ value: 2 });
  assertEquals(values, [{ value: 1 }, { value: 1 }, { value: 2 }]);
  assertThrows(() => r.km.bind("legacy", "x", () => {}));
  assertThrows(() => r.km.bind({ id: "bad", key: "x", command: "test", when: () => true }));
  assertThrows(() => r.km.bind({ id: "bad", key: "x", command: "unknown" }));
});

Deno.test("input: capture popup precedence, blocking scope, select/typing and rejection observation", async () => {
  const r = inputRig(), invoked = [];
  for (const id of ["popup", "decision", "fallback"]) r.handles.register({ id, execute: () => { invoked.push(id); return false; } });
  r.layers.push({ id: "popup", phase: "capture", command: "popup" });
  const native = r.event("Escape", "select", { ctrlKey: true });
  r.policy.dispatch(native, r.km, "capture");
  r.policy.dispatch(native, r.km);
  assertEquals(invoked, ["popup"]);
  r.layers.push({ id: "decision", command: "decision", blocking: true });
  const esc = r.event("Escape");
  assert(!r.policy.dispatch(esc, r.km, "capture"));
  assert(r.policy.dispatch(esc, r.km));
  assertEquals(invoked, ["popup", "decision"]);
  assert(!r.policy.dispatch(r.event("Escape", "select"), r.km));
  r.layers.length = 0;
  r.km.bind({ id: "fallback", key: "x", command: "fallback" });
  assert(!r.policy.dispatch(r.event("x", "input"), r.km));
  const rejected = Promise.reject(new Error("expected rejection"));
  r.handles.register({ id: "reject", execute: () => rejected });
  r.km.bind({ id: "reject", key: "r", command: "reject" });
  assert(r.policy.dispatch(r.event("r"), r.km));
  await assertRejects(() => r.handles.invoke("reject"));
  await Promise.resolve();
  assertEquals(r.errors.length, 1);
});

Deno.test("keys: all twelve default identities/order and permissive programmatic setup", () => {
  assertEquals(CORE_BINDINGS.map(({ id, key, ctx }) => [id, key, ctx]), [
    ["app.keys", "?", "global"], ["keys.close", "Escape", "keys"], ["wb.close", "Escape", "workbench"],
    ["wb.twoUp", "1", "workbench"], ["wb.oneUp", "2", "workbench"], ["wb.split", "3", "workbench"], ["wb.difference", "4", "workbench"],
    ["wb.colLeft", "ArrowLeft", "workbench"], ["wb.colRight", "ArrowRight", "workbench"], ["wb.prev", "ArrowUp", "workbench"], ["wb.next", "ArrowDown", "workbench"], ["wb.lock", "l", "workbench"],
  ]);
  const store = makeAppStore({ pollActivity: false });
  for (const binding of CORE_BINDINGS) store.actions.keys.register(binding);
  store.handles.invoke("workbench.mode", { mode: "split" });
  store.handles.invoke("workbench.column", { column: "right" });
  store.handles.invoke("workbench.lock", { value: false });
  assertEquals([store.state.diff.open, store.state.diff.mode, store.state.diff.col, store.state.diff.locked], [false, "split", "right", false]);
  store.actions.keys.dispatch({ key: "1", preventDefault() { throw new Error("closed shortcut consumed"); } });
  assertEquals(store.state.diff.mode, "split");
  store.dispose();
});

Deno.test("layers: stale same-ID disposer cannot erase a new owner", () => {
  const store = makeAppStore({ pollActivity: false });
  const values = [];
  store.handles.register({ id: "layer.old", execute: () => values.push("old") });
  store.handles.register({ id: "layer.new", execute: () => { values.push("new"); return false; } });
  const old = store.actions.keys.pushLayer({ id: "layer", command: "layer.old" });
  store.actions.keys.pushLayer({ id: "layer", command: "layer.new" });
  old();
  let prevented = 0;
  store.actions.keys.dispatch({ key: "Escape", preventDefault() { prevented++; }, stopPropagation() {} });
  assertEquals(values, ["new"]);
  assertEquals(prevented, 1);
});

Deno.test("feature: dummy private capability/command/binding/affordance joins generically", () => {
  const store = makeAppStore({ pollActivity: false });
  let called = 0;
  store.actions.features.register({ name: "dummy", install: () => ({ commands: [{ id: "dummy.open", execute: () => called++ }], ports: {} }),
    bindings: [{ id: "dummy.key", key: "d", command: "dummy.open" }], cardAction: { command: "dummy.open" }, bulkAction: { command: "dummy.open" } });
  store.handles.invoke("dummy.open");
  store.actions.keys.dispatch({ key: "d", preventDefault() {} });
  assertEquals(called, 2);
  assertEquals(store.state.featureCardActions({ id: "source:file.png" })[0].args, { id: "source:file.png" });
  assertEquals(store.state.featureBulkActions()[0].args, { target: "selected" });
});

Deno.test("modal guard: identical Promise/one continuation, conflicting busy, Cancel and disposal settlement", async () => {
  let permits = 0, shown = null, restored = 0;
  const guard = makeLeaveGuard({ dirty: () => true, suspend() {}, restore() { restored++; }, decision: (value) => shown = value, invalidate() {} });
  const request = { intent: { type: "replace", key: "B" }, permit: () => { permits++; return { status: "applied" }; }, cancel() {} };
  const first = guard.request(request);
  assertStrictEquals(guard.request(request), first);
  assertEquals(await guard.request({ ...request, intent: { type: "replace", key: "C" } }), { status: "busy" });
  guard.cancel();
  assertEquals(await first, { status: "cancelled" });
  assertEquals([shown, permits, restored], [null, 0, 1]);
  const applied = guard.request({ ...request, permit() { permits++; guard.dispose(); return { status: "applied" }; } });
  guard.discard();
  assertEquals(await applied, { status: "applied" });
  assertEquals(permits, 1);
});

Deno.test("modal guard: errors and stale cleanup settle all waiters; automatic dirty never prompts", async () => {
  const guard = makeLeaveGuard({ dirty: () => false, suspend() {}, restore() {}, decision() {}, invalidate() {} });
  await assertRejects(() => guard.request({ intent: { type: "close" }, permit() { throw new Error("permit failed"); } }));
  let shown = 0;
  const dirty = makeLeaveGuard({ dirty: () => true, suspend() {}, restore() {}, decision() { shown++; }, invalidate() {} });
  assertEquals(await dirty.request({ intent: { type: "automatic" } }), { status: "stale" });
  assertEquals(shown, 0);
  const pending = dirty.request({ intent: { type: "close" }, cancel() {} });
  dirty.dispose();
  assertEquals(await pending, { status: "stale" });
});

Deno.test("modal session: scalar mounts, captured destination, fail closed and token-specific cleanup", async () => {
  let current = { open: false };
  const broker = makeVariationSession({ read: () => current, write: (value) => current = value });
  const image = (id) => ({ id, host: "h", filename: id });
  await broker.open([image("A")], false);
  const sessionA = current.session;
  assertEquals(await broker.close(), { status: "stale" });
  let request;
  const cleanup = broker.register(sessionA, { requestLeave: (value) => { request = value; return Promise.resolve({ status: "cancelled" }); }, requestRun: () => "run" });
  const images = [image("B")];
  await broker.open(images, true);
  images.push(image("C"));
  assertEquals(request.permit(), { status: "applied" });
  assertEquals(current.images.map((image) => image.id), ["B"]);
  assert(current.session !== sessionA);
  const cleanupB = broker.register(current.session, { requestLeave: () => Promise.resolve({ status: "cancelled" }), requestRun: () => "new" });
  cleanup();
  assertEquals(broker.run(), "new");
  cleanupB();
  assertEquals(await broker.run(), { status: "stale" });
  assertEquals(request.permit(), { status: "stale" });
});

Deno.test("modal draft: raw/dormant/filter/template edits and exact File identity/order", () => {
  const file = new File(["data"], "local.png"), other = new File(["data"], "other.png");
  const initial = { rawIncrement: "1e", enabled: false, filter: "find", tpl: { dormant: "kept" }, files: [file, other] };
  const copy = snapshotDraft(initial);
  assertStrictEquals(copy.files[0], file);
  assertStrictEquals(copy.files[1], other);
  assert(sameDraft(copy, initial));
  copy.files.reverse();
  assert(!sameDraft(copy, initial));
  assert(!sameDraft(initial, { ...initial, rawIncrement: "1" }));
  assert(!sameDraft(initial, { ...initial, tpl: {} }));
});

Deno.test("keys: saved unknown/null overrides, missing/global collision distinction and exact decline", () => {
  const r = inputRig(), calls = [];
  for (const id of ["first", "second"]) r.handles.register({ id, execute: () => calls.push(id) });
  r.km.setKeymap({ first: null, second: "y", future: "F8" });
  r.km.bind({ id: "first", key: "x", command: "first" });
  r.km.bind({ id: "second", key: "x", ctx: "global", command: "second" });
  assertEquals(r.km.list().map((row) => row.key), ["x", "y"]);
  assertEquals(r.km.findConflict("second", "x"), null);
  r.km.bind({ id: "future", key: "z", command: "first", ctx: "other" });
  assertEquals(r.km.list()[2].key, "F8");
  r.layers.push({ id: "decline", command: "first", decline: () => true });
  r.km.bind({ id: "escape", key: "Escape", command: "second" });
  r.policy.dispatch(r.event("Escape"), r.km);
  assertEquals(calls, ["second"]);
  r.km.resetKey("second");
  assertEquals(r.km.list()[1].key, "x");
});

Deno.test("commands: strict semantic validation and explicit null identity never fall back", () => {
  const store = makeAppStore({ pollActivity: false });
  for (const [id, args] of [
    ["workbench.mode", { mode: "invalid" }], ["workbench.lock", {}], ["workbench.column", { toggle: false }],
    ["image.download", { id: null }], ["image.delete.request", {}],
    ["judgment.apply", { id: "a", intent: { type: "toggle", field: "vote" } }],
    ["judgment.apply", { id: "a", intent: { type: "set", patch: { unknown: true } } }],
    ["judgment.apply", { id: "a", intent: { type: "note", sign: "bad", text: "kept" } }],
  ]) assertThrows(() => store.handles.invoke(id, args));
  assertEquals(store.state.current(), null);
});

Deno.test("commands: pointer/programmatic rejected Promise observed by injected adapter without wrapping", async () => {
  const store = makeAppStore({ pollActivity: false });
  const promise = Promise.reject(new Error("owned request failure"));
  store.handles.register({ id: "test.rejection", execute: () => promise });
  assertStrictEquals(store.handles.get("test.rejection").invoke(), promise);
  await assertRejects(() => promise);
  assert(store.state.chips.some((chip) => chip.msg === "input failed: owned request failure"));
});

Deno.test("variations: explicit cross-source and retained IDs resolve without current-inventory fallback", async () => {
  const targets = [], handles = makeCommandHandles();
  const state = { images: [], imageIdxById: () => new Map(), selected: {}, hosts: { first: { kind: "comfy" }, second: { kind: "comfy" } } };
  const broker = { close() {}, run() {}, open: (images) => { targets.push(images); return Promise.resolve({ status: "applied" }); } };
  for (const command of variationCommands({ state, broker })) handles.register(command);
  assertEquals(await handles.invoke("variations.open", { ids: ["first:dir/a.png", "second:b.png"], bulk: true }), { status: "applied" });
  assertEquals(targets[0].map(({ id, host, filename }) => ({ id, host, filename })), [
    { id: "first:dir/a.png", host: "first", filename: "dir/a.png" }, { id: "second:b.png", host: "second", filename: "b.png" },
  ]);
  for (const id of ["unknown:a.png", "first:../a.png", "first:"])
    assertEquals(await handles.invoke("variations.open", { id }), { status: "stale" });
  assertEquals(targets.length, 1);
});

Deno.test("judgment current target: resolves once and returns the original singular writer Promise", () => {
  const handles = makeCommandHandles(), promise = Promise.resolve({ ok: true });
  let reads = 0, calls = [];
  const state = { currentEntry: () => { reads++; return { entry: { id: "original:a.png" } }; } };
  registerCoreCommands(handles, { state, ops: { diff: {}, judgments: { dispatch: (id, intent) => { calls.push({ id, intent }); return promise; } } } });
  const intent = { type: "toggle", field: "bookmark" };
  assertStrictEquals(handles.invoke("judgment.apply", { target: "current", intent }), promise);
  assertEquals(reads, 1);
  assertEquals(calls, [{ id: "original:a.png", intent }]);
});

Deno.test("command data: accessor, symbol, hidden callback and sparse/cyclic records reject before execution", () => {
  const handles = makeCommandHandles();
  let reads = 0, calls = 0;
  handles.register({ id: "data", execute: () => calls++ });
  const hidden = Object.defineProperty({}, "callback", { value() {}, enumerable: false });
  const hiddenGetter = Object.defineProperty({}, "value", { get() { reads++; return 1; }, enumerable: false });
  const cycle = {}; cycle.self = cycle;
  for (const payload of [
    { get value() { reads++; return 1; } }, { nested: [{ get value() { reads++; return 1; } }] },
    { [Symbol("callback")]() {} }, hidden, hiddenGetter, { ids: Array(1) }, cycle,
  ]) assertThrows(() => handles.invoke("data", payload), TypeError);
  assertEquals(reads, 0);
  assertEquals(calls, 0);
});

Deno.test("command registration: public metadata cannot alias executors or malformed definition fields", () => {
  const handles = makeCommandHandles(), execute = () => "unchanged";
  for (const description of [execute, {}, [], null, 1, Symbol("description")])
    assertThrows(() => handles.register({ id: "bad", description, execute }), TypeError);
  assertThrows(() => handles.register({ id: "bad", execute, validate: true }), TypeError);
  assertThrows(() => handles.register({ id: "bad", execute, files: "yes" }), TypeError);
  assertThrows(() => handles.registerOwned({ id: "bad", description: execute }), TypeError);
  const port = handles.register({ id: "bad", description: "valid", execute });
  assertEquals(port.invoke(), "unchanged");
  assertEquals(handles.list(), [{ id: "bad", description: "valid" }]);
});

Deno.test("command selectors: absent selectors, present undefined and sparse IDs never reach operations", () => {
  const handles = makeCommandHandles();
  let calls = 0;
  const operation = () => { calls++; return Promise.resolve({ ok: true }); };
  const state = { images: [], selected: {}, imageIdxById: () => new Map(), currentEntry: operation };
  registerCoreCommands(handles, { state, ops: { diff: { setMode: operation }, images: { download: operation },
    judgments: { dispatch: operation }, confirm: { open: operation } } });
  for (const selector of [{}, { id: undefined }, { ids: undefined }, { target: undefined }, { ids: Array(1) }, { ids: [undefined] }]) {
    for (const id of ["image.download", "image.delete.request"]) assertThrows(() => handles.invoke(id, selector), TypeError);
    assertThrows(() => handles.invoke("judgment.apply", { ...selector, intent: { type: "toggle", field: "bookmark" } }), TypeError);
  }
  for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__"])
    assertThrows(() => handles.invoke("workbench.mode", JSON.parse(`{"mode":"split","${key}":"unexpected"}`)), TypeError);
  assertEquals(calls, 0);
});

Deno.test("command data: valid plain/null-prototype data, shared containers, File identity and original results remain", () => {
  const handles = makeCommandHandles(), result = Promise.resolve({ ok: true });
  const file = new File(["data"], "keep.png");
  const shared = { value: 0.5 }, args = Object.assign(Object.create(null), { files: [file], a: shared, b: shared, optional: undefined });
  let captured;
  handles.register({ id: "files", files: true, execute: (payload) => { captured = payload; return result; } });
  assertStrictEquals(handles.invoke("files", args), result);
  assertStrictEquals(captured, args);
  assertStrictEquals(captured.files[0], file);
  handles.register({ id: "ordinary", execute() {} });
  assertThrows(() => handles.invoke("ordinary", { file }), TypeError);
});
