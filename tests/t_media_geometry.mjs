import { assertEquals } from "jsr:@std/assert";
import { mediaGeometry, mediaViewRect } from "../client-solid/store/media-geometry.js";
import { cardHeight, measureGeometry, invalidateGeometry } from "../client-solid/store/sizes.js";

Deno.test("media geometry: natural-size cap, hugging and 16:9 minimum are one rule", () => {
  assertEquals(mediaGeometry({ width: 720, size: { w: 640, h: 640 } }),
    { width: 720, height: 640, mediaWidth: 640, mediaHeight: 640, x: 40, y: 0 });
  assertEquals(mediaGeometry({ width: 720, size: { w: 1024, h: 1024 } }),
    { width: 720, height: 720, mediaWidth: 720, mediaHeight: 720, x: 0, y: 0 });
  assertEquals(mediaGeometry({ width: 720, size: { w: 2048, h: 512 } }),
    { width: 720, height: 405, mediaWidth: 720, mediaHeight: 180, x: 0, y: 112.5 });
  assertEquals(mediaGeometry({ width: 1400, size: { w: 640, h: 640 } }).height, 787.5);
  assertEquals(mediaGeometry({ width: 1400, size: { w: 1024, h: 1024, failed: true } }).height, 1400);
});

Deno.test("media geometry: viewer fit and difference draw use the identical natural-size cap", () => {
  const size = { w: 640, h: 640 };
  const g = mediaGeometry({ width: 1800, height: 914, size, surface: "viewer" });
  assertEquals([g.x, g.y, g.mediaWidth, g.mediaHeight], [580, 137, 640, 640]);
  assertEquals(mediaViewRect(size, null, 1800, 914), { dx: 580, dy: 137, dw: 640, dh: 640 });
  assertEquals(mediaViewRect(size, { s: 2, txf: .1, tyf: .2 }, 1800, 914),
    { dx: 440, dy: 457 + .2 * 914 - 640, dw: 1280, dh: 1280 });
});

Deno.test("feed height reserves the stable controls row even for a failed playable entry", () => {
  invalidateGeometry();
  const rect = (width, height) => ({ getBoundingClientRect: () => ({ width, height }) });
  measureGeometry({ ...rect(744, 140), querySelector: s => s === ".imgwrap" ? rect(720, 1) : rect(720, 42) }, 760);
  assertEquals(cardHeight({ w: 640, h: 640, kind: "video" }, 760), 640 + 42 + 139);
  assertEquals(cardHeight({ w: 640, h: 640 }, 760), 640 + 139);
  assertEquals(cardHeight({ w: 1024, h: 1024, failed: true, kind: "video" }, 760), 720 + 42 + 139);
  invalidateGeometry();
});
