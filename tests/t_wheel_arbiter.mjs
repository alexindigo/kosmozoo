import { assertEquals } from "jsr:@std/assert";
import { makeWheelArbiter } from "../client-solid/lib/wheel-arbiter.js";

Deno.test("wheel arbiter: rest arms media only, delta releases once with both axes", () => {
  const a = makeWheelArbiter(0);
  const wheel = (now, extra = {}) => a.wheel({ now, media: true, ctrl: false, dx: 2, dy: 8, ...extra });
  assertEquals(wheel(249).prevent, false);
  a.scrolled(250);
  assertEquals(wheel(499).prevent, false);
  assertEquals(wheel(500, { media: false }).prevent, false);
  assertEquals(wheel(501), { prevent: true, deadline: 621 });
  assertEquals(wheel(520, { dx: -1, dy: 40 }), { prevent: true, release: { dx: 1, dy: 48 } });
  assertEquals(wheel(550).prevent, false);
  a.scrolled(560);
  assertEquals(wheel(809).prevent, false);
  assertEquals(wheel(810).prevent, false);
  assertEquals(wheel(1060), { prevent: true, deadline: 1180 });
});

Deno.test("wheel arbiter: timeout releases accumulated delta exactly once", () => {
  const a = makeWheelArbiter(0);
  a.wheel({ now: 250, media: true, dx: 3, dy: 12 });
  a.wheel({ now: 280, media: true, dx: 5, dy: -2 });
  assertEquals(a.tick(369), null);
  assertEquals(a.tick(370), { dx: 8, dy: 10 });
  assertEquals(a.tick(500), null);
  assertEquals(a.wheel({ now: 501, media: true, dx: 0, dy: 8 }).prevent, false);
});

Deno.test("wheel arbiter: ctrl drops held motion and re-arms only after rest", () => {
  const a = makeWheelArbiter(0);
  a.wheel({ now: 250, media: true, dx: 3, dy: 8 });
  assertEquals(a.wheel({ now: 290, media: true, ctrl: true, dx: 0, dy: -20 }), { prevent: false, pinch: true });
  assertEquals(a.tick(400), null);
  assertEquals(a.wheel({ now: 400, media: true, dx: 0, dy: 8 }).prevent, false);
  assertEquals(a.wheel({ now: 650, media: true, dx: 0, dy: 8 }), { prevent: true, deadline: 770 });
  a.reset(660);
  assertEquals(a.tick(1000), null);
});

Deno.test("wheel arbiter: horizontal-only release and continued gesture are not re-held", () => {
  const a = makeWheelArbiter(0);
  a.wheel({ now: 250, media: true, dx: 20, dy: 0 });
  assertEquals(a.tick(370), { dx: 20, dy: 0 });
  for (const now of [400, 600, 800]) assertEquals(a.wheel({ now, media: true, dx: 10, dy: 0 }).prevent, false);
  assertEquals(a.wheel({ now: 1050, media: true, dx: 10, dy: 0 }), { prevent: true, deadline: 1170 });
});
