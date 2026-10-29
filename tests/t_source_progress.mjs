import { assertEquals } from "jsr:@std/assert";
import { sourceProgress } from "../client-solid/lib/source-progress.js";

const active = (runningCount = 1, queuedCount = 2) => ({ supported: true, state: "running", runningCount, queuedCount,
  progress: { value: 14, max: 32, fraction: .4375 }, progressBasis: "exact",
  workflow: { done: 3.4375, total: 5, fraction: .6875 } });

Deno.test("source presentation: authoritative running plus waiting, shared queue and progress wording", () => {
  const snapshot = active(), view = sourceProgress("source", snapshot, "ready");
  assertEquals(view.queue, { text: "3", label: "3 in queue (1 running, 2 waiting)" });
  assertEquals(view.label, "source: workflow about 3 of 5 steps · current step 14/32 (live) · 3 in queue (1 running, 2 waiting)");
  assertEquals(view.progress, snapshot.progress); assertEquals(view.workflow, snapshot.workflow);
  assertEquals(sourceProgress("source", active(2, 10), "ready").queue.text, "12");
  assertEquals(sourceProgress("source", { ...active(0, 12), state: "idle" }, "ready").queue.text, "12");
});

Deno.test("source presentation: no cached count or fill for unknown, unsupported or disconnected delivery/state", () => {
  for (const state of ["unknown", "disconnected"]) {
    const view = sourceProgress("source", { ...active(), state }, "ready");
    assertEquals(view.queue, null); assertEquals(view.progress, null); assertEquals(view.workflow, null);
    assertEquals(view.label.includes("in queue"), false);
  }
  for (const delivery of ["connecting", "reconnecting", "suspended"]) {
    const view = sourceProgress("source", active(), delivery);
    assertEquals(view.status, "disconnected"); assertEquals(view.queue, null);
    assertEquals(view.progress, null); assertEquals(view.workflow, null);
    assertEquals(view.label, "source: activity delivery disconnected; cached upstream running");
  }
  assertEquals(sourceProgress("folder", { supported: false, reason: "No generation jobs for folder sources" }, "ready").queue, null);
  assertEquals(sourceProgress("source", undefined, "ready").queue, null);
  assertEquals(sourceProgress("source", { ...active(0, 0), state: "idle" }, "ready").queue, null);
});

Deno.test("source presentation: cap only the visible count above 999, preserve exact accessible totals", () => {
  for (const [running, waiting, text] of [[1, 0, "1"], [1, 11, "12"], [1, 998, "999"], [1, 999, "999+"], [2, 12345, "999+"]]) {
    const view = sourceProgress("source", active(running, waiting), "ready");
    assertEquals(view.queue.text, text);
    assertEquals(view.queue.label, `${running + waiting} in queue (${running} running, ${waiting} waiting)`);
  }
});
