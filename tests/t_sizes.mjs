// tests/t_sizes.mjs — the card-height formula and the sizes resolver:
// cardHeight for 16:9 / tall / wide / zero-height inputs, and resolveAhead's
// behind-first order with the MAX_INFLIGHT bound (a fake Image drives the
// loader without a DOM).

import { assert, assertEquals } from "jsr:@std/assert";
import { cardHeight, makeSizes, measureGeometry, invalidateGeometry } from "../client-solid/store/sizes.js";

// measureGeometry reads the probe's rects — fake the element shape it reads
function fakeProbe(wrapW, cardH, wrapH) {
  return {
    querySelector: () => ({ getBoundingClientRect: () => ({ width: wrapW, height: wrapH }) }),
    getBoundingClientRect: () => ({ height: cardH }),
  };
}

Deno.test("cardHeight: 16:9 / tall / wide / zero-height", () => {
  invalidateGeometry();
  measureGeometry(fakeProbe(383, 530, 383), 425); // inset 42, chrome 147
  const COLW = 425;
  // 16:9: image box = (colW - inset) / (16/9), plus chrome
  assertEquals(cardHeight({ w: 1600, h: 900 }, COLW), Math.round((383 / (16 / 9)) * 64) / 64 + 147);
  // tall: the box uses the image's own aspect (taller than the 16:9 floor)
  assertEquals(cardHeight({ w: 900, h: 1600 }, COLW), Math.round((383 / (900 / 1600)) * 64) / 64 + 147);
  // wide: the aspect is capped at 16:9 — never shorter than the floor
  assertEquals(cardHeight({ w: 3200, h: 900 }, COLW), cardHeight({ w: 1600, h: 900 }, COLW));
  // zero height: the formula must not divide by zero — the 16:9 floor stands
  assertEquals(cardHeight({ w: 100, h: 0 }, COLW), cardHeight({ w: 1600, h: 900 }, COLW));
});

// A fake Image: construction registers; the test fires onload/onerror by hand
function fakeImageEnv() {
  const made = [];
  globalThis.Image = class {
    constructor() {
      this.naturalWidth = 640;
      this.naturalHeight = 360;
      made.push(this);
    }
    set src(v) {
      this._src = v;
      queueMicrotask(() => this.onload?.());
    }
    get src() { return this._src; }
  };
  return made;
}

Deno.test("resolveAhead: behind-first order, MAX_INFLIGHT bound", async () => {
  const made = fakeImageEnv();
  const entries = Array.from({ length: 100 }, (_, i) => ({ id: `h:f${i}.png` }));
  const sizes = makeSizes({
    srcFor: (id) => `bytes:${id}`,
    imageAt: (i) => entries[i],
  });
  const viewIdx = entries.map((_, i) => i);
  // 50 pending above the first visible → the behind window is ALL of them
  sizes.resolveAhead(viewIdx, 50, 60);
  // MAX_INFLIGHT: exactly 6 started, and they are the first 6 BEHIND entries
  assertEquals(made.length, 6);
  assertEquals(made.map((m) => m.src), entries.slice(0, 6).map((e) => `bytes:${e.id}`));
  // landing those stages the next behind entries — still no ahead entry
  for (const m of made.splice(0)) queueMicrotask(() => {});
  await new Promise((r) => setTimeout(r, 30));
  const started = made.map((m) => m.src);
  assert(started.every((s) => entries.slice(0, 50).some((e) => `bytes:${e.id}` === s)),
    `only behind entries are in flight: ${started.join(",")}`);

  // > 50 pending above → the behind window clamps to RESOLVE_BEHIND (10)
  const made2 = fakeImageEnv();
  const sizes2 = makeSizes({
    srcFor: (id) => `bytes:${id}`,
    imageAt: (i) => entries[i],
  });
  sizes2.resolveAhead(viewIdx, 80, 90);
  assertEquals(made2.map((m) => m.src), entries.slice(70, 76).map((e) => `bytes:${e.id}`));

  delete globalThis.Image;
});
