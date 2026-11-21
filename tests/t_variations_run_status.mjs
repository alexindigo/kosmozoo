import { assertEquals } from "jsr:@std/assert";
import { runStatus } from "../client-solid/features/variations/run-status.js";

Deno.test("Run status keeps complete readiness and unchecked guidance in one projection", () => {
  const message = "A long conflict description. ".repeat(40);
  const preview = { status: "conflict", message, uncheckedMessage: "3 recorded inputs are unchecked." };
  const status = runStatus({ preview, result: null, unavailable: "Source is unavailable." });
  assertEquals(status.items.map(item => item.text), ["Source is unavailable.", message, preview.uncheckedMessage]);
  assertEquals(status.fullText, status.items.map(item => item.text).join("\n"));
  assertEquals(status.items.map(item => item.class), ["vz-readiness-error", "vz-readiness-error", "vz-field-help"]);
  assertEquals(status.retry, false);
});

Deno.test("Current failed preview precedes the labelled previous Run without claiming unconfirmed jobs queued", () => {
  const preview = { status: "failed", message: "Old preview", uncheckedMessage: "Old guidance" };
  const result = { submitted: 2, total: 3, ok: false, reason: "One image remains.\nNothing was retried." };
  const status = runStatus({ preview, result });
  assertEquals(status.items, [{ text: "Old preview", class: "vz-readiness-error" }, { text: "2 reported of 3 jobs; complete acceptance is not confirmed.", class: "vz-queued" }, { text: "Previous Run: " + result.reason, class: "vz-error" }]);
  assertEquals(status.fullText, status.items.map(item => item.text).join("\n"));
  assertEquals(status.retry, true, "catalogue Retry remains available even after a blocked Run");
});

Deno.test("Empty and successful Run status preserve their presentation semantics", () => {
  assertEquals(runStatus({ preview: { status: "ready" } }), { items: [], retry: false, fullText: "" });
  const status = runStatus({ preview: { status: "ready" }, result: { ok: true, submitted: 1, total: 1, text: "Closing shortly." } });
  assertEquals(status.items, [{ text: "Queued 1 of 1 jobs", class: "vz-queued vz-ok" }, { text: "Closing shortly.", class: "vz-error vz-neutral" }]);
});

Deno.test("Run status precedence: warnings such as no Pexels services never displace the zero-work explanation", async () => {
  const { planPresentation } = await import("../client-solid/features/variations/plan-presentation.js");
  const { variationProblem, problemText } = await import("../src/features/variations/problems.mjs");
  const zero = variationProblem("no-work", { phase: "plan", target: { index: 0, name: "feeds-target.png" }, detail: "No work for this image; choose a different value, image or destination." });
  const preview = planPresentation([{ index: 0, count: 0, problem: zero }], [{ id: "fake:feeds-target.png", filename: "feeds-target.png" }]);
  const warnings = [variationProblem("no-pexels", { severity: "warning", phase: "acquisition" }),
    variationProblem("time-unavailable", { severity: "warning", phase: "metadata", numbers: { missing: 1, total: 1 }, names: ["feeds-target.png"] })];
  const status = runStatus({ preview, result: null, problems: warnings });
  assertEquals(status.items.map(item => item.text), [problemText(zero), ...warnings.map(problemText)]);
  assertEquals(status.items.map(item => item.class), ["vz-readiness-error", "vz-field-help", "vz-field-help"]);
});

Deno.test("Run status precedence: blocking > explanation > progress > warning > ready, in one owner", async () => {
  const { variationProblem, problemText } = await import("../src/features/variations/problems.mjs");
  const blocking = variationProblem("acquisition-retired", { phase: "acquisition", parameter: { id: "11.image", label: "Image" }, resource: "photo.png" });
  const warning = variationProblem("no-pexels", { severity: "warning", phase: "acquisition" });
  const checking = runStatus({ preview: { status: "checking", message: "Checking every image...", uncheckedMessage: "1 recorded input is unchecked." }, result: null, problems: [warning, blocking] });
  assertEquals(checking.items.map(item => item.text), [problemText(blocking), "Checking every image...", "1 recorded input is unchecked.", problemText(warning)]);
  const ready = runStatus({ preview: { status: "ready", n: 4, message: "Estimated from the opening workflow." }, result: null, problems: [warning] });
  assertEquals(ready.items.map(item => item.text), [problemText(warning), "Estimated from the opening workflow."]);
  const tooMany = variationProblem("too-many", { phase: "plan", numbers: { count: 1020 } });
  const mixed = runStatus({ preview: { status: "ready", n: 3 }, result: null, problems: [warning, tooMany, blocking] });
  assertEquals(mixed.items.map(item => item.text), [problemText(blocking), problemText(tooMany), problemText(warning)]);
});
