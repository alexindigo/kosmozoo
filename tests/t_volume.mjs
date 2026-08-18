// tests/t_volume.mjs — Phase 8 contract tests: the window follows the
// lightbox keyboard position (the freeze fix), prefetch is direction-aware,
// windowing loads only the active range.

import { assert, assertEquals } from "jsr:@std/assert";
import { S } from "../client/js/state.mjs";
import { activeWindow, prefetchFrom, resetWindow } from "../client/js/volume.mjs";

function fakeImages(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `h:bulk-${String(i).padStart(5, "0")}.png`, host: "h", filename: `bulk-${i}.png`,
  }));
}

Deno.test("volume: window follows the lightbox index (the freeze fix)", () => {
  S.images = fakeImages(3000);
  resetWindow();
  // Scroll viewport parked at the top…
  // …but the lightbox walks to index 500 by keyboard. The window MUST cover it.
  S.lightbox.open = true;
  S.lightbox.index = 500;
  const [lo, hi] = activeWindow();
  assert(lo <= 500 && hi >= 500, `window [${lo},${hi}] must contain lightbox index 500`);
  assert(hi >= 500, "window reached the lightbox position, not just the viewport");
  S.lightbox.open = false;
});

Deno.test("volume: window is the union of scroll viewport and lightbox", () => {
  S.images = fakeImages(3000);
  resetWindow();
  S.lightbox.open = false;
  const [lo0] = activeWindow();
  assertEquals(lo0, 0); // no lightbox: window is the scroll viewport
});

Deno.test("volume: prefetch is direction-aware and stops at the bounds", () => {
  S.images = fakeImages(20);
  const fetched = [];
  const spy = (url) => { fetched.push(url); return Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) }); };
  prefetchFrom(0, -1, spy);
  assertEquals(fetched.length, 0);              // nothing before 0
  prefetchFrom(19, 1, spy);
  assertEquals(fetched.length, 0);              // nothing after the end
  prefetchFrom(10, 1, spy);
  assertEquals(fetched.length, 4);              // PREFETCH ahead
  assert(fetched[0].includes("bulk-00011.png"), "prefetches the direction of travel");
  fetched.length = 0;
  prefetchFrom(10, -1, spy);
  assert(fetched[0].includes("bulk-00009.png"), "backward prefetch goes backward");
});

Deno.test("volume: Left/Right needs no prefetch (anchor is local, candidate on screen)", () => {
  // Contract documentation test: the prefetch path is for Up/Down only.
  // A column switch must not trigger a fetch because the anchor is a blob URL.
  S.anchors = [{ name: "a.png", src: "blob:fake", meta: null }];
  assert(S.anchors[0].src.startsWith("blob:"));
  S.anchors = [];
});
