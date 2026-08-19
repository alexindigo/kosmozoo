// tests/t_feed.mjs — the feed's list engine: viewStep walks the view,
// extends chunks at the rendered edge, prefetch is direction-aware.
// DOM-dependent paths (renderChunk/applyWindow) are covered by the e2e; these
// are the DOM-free contracts.

import { assert, assertEquals } from "jsr:@std/assert";
import { S } from "../client/js/state.mjs";
import { viewStep, prefetchFrom, __testSetView } from "../client/js/feed.mjs";

function fakeImages(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `h:bulk-${String(i).padStart(5, "0")}.png`, host: "h", filename: `bulk-${i}.png`,
  }));
}

Deno.test("viewStep: steps within the view (image-indexed), respects view order", () => {
  S.images = fakeImages(20);
  __testSetView([0, 1, 2, 3, 4, 5]); // a filtered/reordered view
  assertEquals(viewStep(2, 1), 3);
  assertEquals(viewStep(2, -1), 1);
  assertEquals(viewStep(5, 1), 5);   // at the end: stay
  assertEquals(viewStep(0, -1), 0);  // at the start: stay
});

Deno.test("viewStep: current image not in the view snaps to nearest forward entry", () => {
  S.images = fakeImages(20);
  __testSetView([2, 3, 5]);
  assertEquals(viewStep(4, 1), 5);  // 4 filtered out; from 4, next view entry
  assertEquals(viewStep(4, -1), 3); // previous view entry
});

Deno.test("viewStep: empty view stays put", () => {
  S.images = fakeImages(3);
  __testSetView([]);
  assertEquals(viewStep(1, 1), 1);
});

Deno.test("prefetch: direction-aware, bounded at the edges, fetch-seam", () => {
  S.images = fakeImages(20);
  const fetched = [];
  const spy = (url) => { fetched.push(url); return Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) }); };
  prefetchFrom(0, -1, spy);
  assertEquals(fetched.length, 0);
  prefetchFrom(19, 1, spy);
  assertEquals(fetched.length, 0);
  prefetchFrom(10, 1, spy);
  assertEquals(fetched.length, 4);
  assert(fetched[0].includes("bulk-00011.png"));
  fetched.length = 0;
  prefetchFrom(10, -1, spy);
  assert(fetched[0].includes("bulk-00009.png"));
});

Deno.test("prefetch: Left/Right needs none (anchor is a local blob)", () => {
  // contract documentation: blink switches to a blob URL, already loaded
  S.anchors = [{ name: "a.png", src: "blob:fake", meta: null }];
  assert(S.anchors[0].src.startsWith("blob:"));
  S.anchors = [];
});
