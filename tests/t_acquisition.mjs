import { assert, assertEquals } from "jsr:@std/assert";
import { acquisitionWindow, makeAcquisition } from "../client-solid/store/acquisition.js";

const deferred = () => {
  let resolve;
  const promise = new Promise(yes => resolve = yes);
  return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture() {
  const idle = new Map();
  let sequence = 0, time = 0;
  const policy = makeAcquisition({ now: () => time,
    scheduleIdle: callback => { const id = ++sequence; idle.set(id, callback); return () => idle.delete(id); } });
  policy.setContext({ source: "A", session: 1 });
  policy.setWindow({ ids: ["front", "second"], currentId: "front", limit: 1 });
  return { policy, idle, advance: ms => time += ms,
    turn() { const next = idle.entries().next().value; assert(next, "an idle continuation must be scheduled"); idle.delete(next[0]); next[1]({ timeRemaining: () => 50 }); } };
}

Deno.test("acquisition projection: sparse viewport identities and current share one bounded current-first window", () => {
  const ids = Array.from({ length: 100 }, (_, i) => `id-${i}`);
  const window = acquisitionWindow({ ids, currentId: "id-60", viewportIds: ["id-58", "id-61"], limit: 20 });
  assertEquals(window.length, 20);
  assertEquals(window[0], "id-60");
  assert(window.includes("id-58") && window.includes("id-61"));
  assert(!window.includes("id-0"), "known-list positions must never be interpreted as view positions");
  assertEquals(acquisitionWindow({ ids, currentId: "id-99", limit: 20 }).length, 20);
  const loadingMotion = acquisitionWindow({ ids, currentId: "id-0", viewportIds: ["id-58", "id-61"], limit: 20 });
  assertEquals(loadingMotion[0], "id-0", "loading-time acquisition does not rewrite committed current");
  assertEquals(loadingMotion.length, 20);
  assert(loadingMotion.includes("id-58") && loadingMotion.includes("id-61"), "the settled viewport still gets foreground admission");
});

Deno.test("acquisition: foreground precedes idle background and all resource paths share the two-slot budget", async () => {
  const f = fixture(), starts = [], held = [deferred(), deferred(), deferred()];
  try {
    const background = held.map((hold, i) => f.policy.submit({ key: `path-${i}`, id: "second", run: ({ priority }) => {
      starts.push([`background-${i}`, priority]); return hold.promise;
    } }));
    const front = deferred();
    const foreground = f.policy.submit({ key: "front-size", id: "front", run: ({ priority }) => {
      starts.push(["foreground", priority]); return front.promise;
    } });
    assertEquals(starts, [["foreground", "foreground"]]);
    assertEquals(f.idle.size, 0, "pending foreground withholds background admission");
    front.resolve(); await foreground; await flush();
    f.turn();
    assertEquals(starts.slice(1), [["background-0", "background"], ["background-1", "background"]]);
    assertEquals(f.idle.size, 0, "a full budget must not spin idle callbacks");
    held[0].resolve(); await flush(); f.turn();
    assertEquals(starts.at(-1), ["background-2", "background"]);
    held.forEach(hold => hold.resolve()); await Promise.all(background);
  } finally { held.forEach(hold => hold.resolve()); f.policy.dispose(); }
});

Deno.test("acquisition: background CPU work yields after eight milliseconds even with idle time left", async () => {
  const f = fixture(), starts = [];
  try {
    const tasks = Array.from({ length: 5 }, (_, i) => f.policy.submit({ key: `batch-${i}`, resource: false,
      run: () => { starts.push(i); f.advance(4); } }));
    f.turn(); assertEquals(starts, [0, 1]);
    await flush(); f.turn(); assertEquals(starts, [0, 1, 2, 3]);
    await flush(); f.turn(); await Promise.all(tasks); assertEquals(starts.length, 5);
  } finally { f.policy.dispose(); }
});

Deno.test("acquisition: an expired idle deadline permits bounded progress when the browser has no idle time", async () => {
  const f = fixture(); let started = false;
  try {
    const task = f.policy.submit({ key: "timed-out", resource: false, run: () => { started = true; } });
    const [key, callback] = f.idle.entries().next().value;
    f.idle.delete(key); callback({ didTimeout: true, timeRemaining: () => 0 });
    await task; assert(started);
  } finally { f.policy.dispose(); }
});

Deno.test("acquisition: gesture pauses new work, started resources finish and queued identities promote on settle", async () => {
  const f = fixture(), starts = [], held = deferred();
  try {
    const running = f.policy.submit({ key: "started", id: "front", run: () => { starts.push("started"); return held.promise; } });
    f.policy.setGesture(true);
    const queued = f.policy.submit({ key: "next", id: "second", run: ({ priority }) => starts.push(priority) });
    const duplicate = f.policy.submit({ key: "next", id: "second", run: () => { throw Error("duplicate executor"); } });
    assertEquals(queued, duplicate);
    held.resolve(); await running; await flush();
    assertEquals(starts, ["started"]); assertEquals(f.idle.size, 0);
    f.policy.setWindow({ ids: ["front", "second"], currentId: "second", limit: 1 });
    f.policy.setGesture(false); await queued;
    assertEquals(starts, ["started", "foreground"]);
  } finally { held.resolve(); f.policy.dispose(); }
});

Deno.test("acquisition: context and content retirement fence queued starts and late publishers", async () => {
  const f = fixture(), old = deferred();
  let content = "old", lateCurrent;
  try {
    const running = f.policy.submit({ key: "old", id: "front", valid: () => content === "old",
      run: async ({ current }) => { await old.promise; lateCurrent = current(); } });
    let staleStarted = false;
    const queued = f.policy.submit({ key: "stale", valid: () => content === "old", run: () => { staleStarted = true; } });
    content = "new";
    f.policy.setWindow({ ids: ["front", "second"], currentId: "front", limit: 1 });
    await queued;
    assertEquals(staleStarted, false);
    const retired = f.policy.submit({ key: "retired", run: () => { staleStarted = true; } });
    f.policy.setContext({ source: "A", session: 2 });
    assertEquals(await retired, { retired: true });
    old.resolve(); await running;
    assertEquals(lateCurrent, false);
    assertEquals(staleStarted, false);
  } finally { old.resolve(); f.policy.dispose(); }
});
