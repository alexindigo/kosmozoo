// tests/t_axes.mjs — axis cycling: exclusive values, needs-driven
// availability with reasons, skip-with-reason behaviour.

import { assert, assertEquals } from "jsr:@std/assert";
import { state } from "../client/js/state.mjs";
import { AXES, axisAvailable, cycleAxis, axisStatus } from "../client/js/axes.mjs";

Deno.test("axes: cycling an exclusive axis always lands on a declared value", () => {
  state.axes.alignment = "shared";
  for (let i = 0; i < AXES.alignment.length; i++) {
    const v = cycleAxis("alignment");
    assert(AXES.alignment.includes(v));
  }
});

Deno.test("axes: face-anchored is skipped with a reason when the detector is unconfigured", () => {
  state.detector = { state: "unconfigured" };
  const a = axisAvailable("alignment", "face-anchored");
  assertEquals(a.ok, false);
  assert(a.reason.includes("serviceUrl"), "reason names the missing config");
  // cycling from shared must skip face-anchored and land on independent
  state.axes.alignment = "shared";
  const v = cycleAxis("alignment", 1);
  assertEquals(v, "independent");
  assert(state.axisReason.includes("face-anchored"), "skip reason surfaced");
  assert(state.axisReason.includes("serviceUrl"));
});

Deno.test("axes: face-anchored becomes available when the detector is ready", () => {
  state.detector = { state: "ready" };
  assertEquals(axisAvailable("alignment", "face-anchored").ok, true);
  state.axes.alignment = "shared";
  assertEquals(cycleAxis("alignment", 1), "face-anchored");
  state.detector = { state: "unconfigured" }; // restore
  state.axes.alignment = "shared";
});

Deno.test("axes: flicker is the default composition and always available", () => {
  assertEquals(state.axes.composition, "flicker");
  assertEquals(axisAvailable("composition", "flicker").ok, true);
});

Deno.test("axes: axisStatus names both axes and any skip reason", () => {
  state.axes.alignment = "shared";
  state.axes.composition = "flicker";
  state.axisReason = null;
  assertEquals(axisStatus(), "align:shared comp:flicker");
});
