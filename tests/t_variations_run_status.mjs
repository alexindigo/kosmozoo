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

Deno.test("Run results replace preview guidance without dropping queued counts or failure text", () => {
  const preview = { status: "failed", message: "Old preview", uncheckedMessage: "Old guidance" };
  const result = { submitted: 2, total: 3, ok: false, reason: "One image remains.\nNothing was retried." };
  const status = runStatus({ preview, result });
  assertEquals(status.items, [{ text: "Queued 2 of 3 jobs", class: "vz-queued" }, { text: result.reason, class: "vz-error" }]);
  assertEquals(status.fullText, "Queued 2 of 3 jobs\n" + result.reason);
  assertEquals(status.retry, true, "catalogue Retry remains available even after a blocked Run");
});

Deno.test("Empty and successful Run status preserve their presentation semantics", () => {
  assertEquals(runStatus({ preview: { status: "ready" } }), { items: [], retry: false, fullText: "" });
  const status = runStatus({ preview: { status: "ready" }, result: { ok: true, submitted: 1, total: 1, text: "Closing shortly." } });
  assertEquals(status.items, [{ text: "Queued 1 of 1 jobs", class: "vz-queued vz-ok" }, { text: "Closing shortly.", class: "vz-error vz-neutral" }]);
});
