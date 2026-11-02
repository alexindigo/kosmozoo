import { assertEquals } from "jsr:@std/assert";
import { targetRunPlan } from "../src/features/variations/shared.mjs";
import { editorRig } from "./helpers/variation-editor.mjs";

Deno.test("target plan: heterogeneous relative numeric absence is explicit, other operations stay applicable", () => {
  const rig = editorRig(), payload = { relative: true, ranges: { "missing.value": { enabled: true, min: -1, max: 1, increment: 1, clamp: [0, 10] }, "n.denoise": { enabled: false } }, imageParams: { "text.text": { enabled: true, values: ["next"] } }, prefix: "", suffix: "" };
  const plan = targetRunPlan(payload, rig.catalogue);
  assertEquals(plan.operations.find(operation => operation.parameter === "missing.value").disposition, "absent-relative-numeric");
  assertEquals(plan.payload.ranges, { "n.denoise": { enabled: false } });
  assertEquals(plan.operations.find(operation => operation.parameter === "text.text").disposition, "apply");
  assertEquals(payload.ranges["missing.value"].enabled, true); rig.editor.dispose();
});
