// tests/t_axes.mjs — axis cycling: exclusive values, needs-driven
// availability with reasons, skip-with-reason behaviour.

import { assert, assertEquals } from "jsr:@std/assert";
import { S } from "../client/js/state.mjs";
import { AXES, axisAvailable, cycleAxis, axisStatus } from "../client/js/axes.mjs";

Deno.test("axes: cycling an exclusive axis always lands on a declared value", () => {
  S.axes.alignment = "shared";
  for (let i = 0; i < AXES.alignment.length; i++) {
    const v = cycleAxis("alignment");
    assert(AXES.alignment.includes(v));
  }
});

Deno.test("axes: face-anchored is skipped with a reason when the detector is unconfigured", () => {
  S.detector = { state: "unconfigured" };
  const a = axisAvailable("alignment", "face-anchored");
  assertEquals(a.ok, false);
  assert(a.reason.includes("serviceUrl"), "reason names the missing config");
  // cycling from shared must skip face-anchored and land on independent
  S.axes.alignment = "shared";
  const v = cycleAxis("alignment", 1);
  assertEquals(v, "independent");
  assert(S.axisReason.includes("face-anchored"), "skip reason surfaced");
  assert(S.axisReason.includes("serviceUrl"));
});

Deno.test("axes: face-anchored becomes available when the detector is ready", () => {
  S.detector = { state: "ready" };
  assertEquals(axisAvailable("alignment", "face-anchored").ok, true);
  S.axes.alignment = "shared";
  assertEquals(cycleAxis("alignment", 1), "face-anchored");
  S.detector = { state: "unconfigured" }; // restore
  S.axes.alignment = "shared";
});

Deno.test("axes: flicker is the default composition and always available", () => {
  assertEquals(S.axes.composition, "flicker");
  assertEquals(axisAvailable("composition", "flicker").ok, true);
});

Deno.test("axes: axisStatus names both axes and any skip reason", () => {
  S.axes.alignment = "shared";
  S.axes.composition = "flicker";
  S.axisReason = null;
  assertEquals(axisStatus(), "align:shared comp:flicker");
});
