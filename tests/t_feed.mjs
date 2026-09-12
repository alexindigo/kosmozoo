// tests/t_feed.mjs — the feed's view walk: viewStep walks the view,
// prefetch is direction-aware. DOM-dependent paths (the virtualized window,
// the image window) are covered by the e2e; these are the DOM-free
// contracts.

import { assert, assertEquals } from "jsr:@std/assert";
import { viewStep, prefetchFrom } from "../client/js/feedview.mjs";

function fakeImages(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `h:bulk-${String(i).padStart(5, "0")}.png`, host: "h", filename: `bulk-${String(i).padStart(5, "0")}.png`,
  }));
}

Deno.test("viewStep: steps within the view (image-indexed), respects view order", () => {
  const view = [0, 1, 2, 3, 4, 5]; // a filtered/reordered view
  assertEquals(viewStep(view, 2, 1), 3);
  assertEquals(viewStep(view, 2, -1), 1);
  assertEquals(viewStep(view, 5, 1), 5);   // at the end: stay
  assertEquals(viewStep(view, 0, -1), 0);  // at the start: stay
});

Deno.test("viewStep: current image not in the view snaps to nearest forward entry", () => {
  const view = [2, 3, 5];
  assertEquals(viewStep(view, 4, 1), 5);  // 4 filtered out; from 4, next view entry
  assertEquals(viewStep(view, 4, -1), 3); // previous view entry
});

Deno.test("viewStep: empty view stays put", () => {
  assertEquals(viewStep([], 1, 1), 1);
});

Deno.test("prefetch: direction-aware, bounded at the edges, fetch-seam", () => {
  const images = fakeImages(20);
  const fetched = [];
  const spy = (url) => { fetched.push(url); return Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) }); };
  prefetchFrom(images, 0, -1, spy);
  assertEquals(fetched.length, 0);
  prefetchFrom(images, 19, 1, spy);
  assertEquals(fetched.length, 0);
  prefetchFrom(images, 10, 1, spy);
  assertEquals(fetched.length, 4);
  assert(fetched[0].includes("bulk-00011.png"));
  fetched.length = 0;
  prefetchFrom(images, 10, -1, spy);
  assert(fetched[0].includes("bulk-00009.png"));
});
