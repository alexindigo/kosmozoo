import { assert, assertEquals } from "jsr:@std/assert";
import { scrollSample, lookaheadBand, lookaheadRange, demandOrder } from "../client-solid/features/variations/lookahead.js";

Deno.test("picker lookahead: slow movement keeps 15/15; velocity expands only travel side and expires at 300ms", () => {
  const start = scrollSample(null, 0, 0);
  const slow = scrollSample(start, 10, 100);
  assertEquals(lookaheadBand(slow, 100, 102, 3), { direction: 1, above: 15, below: 15 });
  const fast = scrollSample(start, 4000, 100);
  assertEquals(lookaheadBand(fast, 100, 102, 3), { direction: 1, above: 15, below: 90 });
  assertEquals(lookaheadBand(fast, 400, 102, 3), { direction: 0, above: 15, below: 15 });
  const reverse = scrollSample(fast, 0, 200);
  assertEquals(lookaheadBand(reverse, 200, 102, 3), { direction: -1, above: 90, below: 15 });
  assertEquals(scrollSample(fast, 4000, 110), fast, "unchanged offsets cannot prolong velocity");
});

Deno.test("picker lookahead: sorted unique bounded geometry and visible/ahead/behind demand order", () => {
  const range = { startIndex: 40, endIndex: 42, count: 100 };
  const indices = lookaheadRange(range, { above: 15, below: 90 }, 3);
  assertEquals(indices, Array.from({ length: 38 }, (_, i) => 35 + i));
  for (const direction of [1, -1]) {
    const order = [...indices].sort((a, b) => demandOrder(a, b, range, direction));
    assertEquals(order.slice(0, 3), [40, 41, 42]);
    assertEquals(order[3], direction > 0 ? 43 : 39);
    assert(order.indexOf(direction > 0 ? 72 : 35) < order.indexOf(direction > 0 ? 39 : 43));
  }
  assertEquals(lookaheadRange({startIndex:0,endIndex:1,count:3},{above:90,below:90},2),[0,1,2]);
});
