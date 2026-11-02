import { assertEquals } from "jsr:@std/assert";
import { scrollTapeOffset } from "../client/js/rail.mjs";

Deno.test("rail scroll offset: pixels retain fractional trackpad motion; rows stay whole at presentation", () => {
  let offset = 0;
  for (let i = 0; i < 5; i++) offset = scrollTapeOffset(400, 100, offset, 1, 0, 5);
  assertEquals(offset, 1);
  assertEquals(scrollTapeOffset(400, 100, 10, 100, 0, 5), 30);
});

Deno.test("rail scroll offset: line/page units and both bounds use the same tape capacity", () => {
  assertEquals(scrollTapeOffset(400, 100, 10, 3, 1, 5), 13);
  assertEquals(scrollTapeOffset(400, 100, 10, 1, 2, 5), 110);
  assertEquals(scrollTapeOffset(400, 100, 10, -100, 0, 5), 0);
  assertEquals(scrollTapeOffset(400, 100, 290, 100, 0, 5), 300);
  assertEquals(scrollTapeOffset(40, 100, 10, 100, 0, 5), 0);
  assertEquals(scrollTapeOffset(400, 0, 10, 100, 0, 5), 0);
});
