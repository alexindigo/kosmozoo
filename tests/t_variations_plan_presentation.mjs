import { assert, assertEquals } from "jsr:@std/assert";
import { planPresentation } from "../client-solid/features/variations/plan-presentation.js";
import { runStatus } from "../client-solid/features/variations/run-status.js";

const problem = { code: "too-many", message: "612 jobs for this image; the limit is 500 per image." };
const targets = [{ id: "one", filename: "one.png" }, { id: "two", filename: "two.png" }];
Deno.test("plan presentation: real over-limit count and reason survive without a strip and beside a previous result", () => {
  const preview = planPresentation([{ index: 0, count: 612, problem }], targets.slice(0, 1));
  assertEquals(preview.n, 612);
  assertEquals(preview.display, "612"); assert(preview.overLimit);
  assertEquals(preview.status, "blocked"); assertEquals(preview.admitted, []);
  assertEquals(preview.problems.get("one"), problem); assertEquals(preview.message, problem.message);
  for (const result of [null, { submitted: 1, total: 1, ok: true, text: "Previous Run" }]) {
    const status = runStatus({ preview, result });
    assert(status.fullText.includes(problem.message));
    assertEquals(status.items[0].class, "vz-readiness-error"); assertEquals(status.retry, false);
  }
});
Deno.test("plan presentation: mixed/all rejected cohorts retain every reason and only admit productive siblings", () => {
  const missing = { code: "missing-class", message: "Not installed: LoadImage." };
  for (const second of [{ index: 1, count: 2, problem: null }, { index: 1, count: 0, problem: missing }]) {
    const preview = planPresentation([{ index: 0, count: 612, problem }, second], targets);
    assertEquals(preview.n, 612 + second.count);
    assertEquals(preview.admitted, second.problem ? [] : [second]);
    assert(preview.message.includes("one.png: " + problem.message));
    if (second.problem) assert(preview.message.includes("two.png: " + missing.message));
  }
  const zero = planPresentation([{ index: 0, count: 0, problem: { code: "no-work", message: "Choose another value." } }], targets.slice(0, 1));
  assertEquals(zero.display, "0"); assertEquals(zero.message, "Choose another value.");
});
