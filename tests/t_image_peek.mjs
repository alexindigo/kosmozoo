import { assert, assertEquals } from "jsr:@std/assert";
import { makeImagePeek, containBox, peekBox, flipTransform, typingTarget, PEEK_MARGIN } from "../client-solid/features/variations/image-peek.js";

const element = (rect, extra = {}) => ({ isConnected: true, getBoundingClientRect: () => rect, matches: () => false, ...extra });
const key = (init = {}) => ({ key: " ", repeat: false, target: element({}), ...init });

Deno.test("image peek geometry: fitted viewport box, contained tile picture and uniform FLIP", () => {
  const round = box => Object.fromEntries(Object.entries(box).map(([name, value]) => [name, Math.round(value * 1000) / 1000]));
  assertEquals(round(peekBox({ width: 96, height: 64 }, { width: 1400, height: 1000 })), { left: 32, top: 54.667, width: 1336, height: 890.667 });
  const tall = peekBox({ width: 64, height: 96 }, { width: 1400, height: 1000 });
  assertEquals([tall.top, tall.height], [PEEK_MARGIN, 1000 - 2 * PEEK_MARGIN]);
  assertEquals(tall.left, (1400 - tall.width) / 2);
  const tile = containBox({ width: 96, height: 64 }, { left: 10, top: 20, width: 96, height: 96 });
  assertEquals(tile, { left: 10, top: 36, width: 96, height: 64 });
  assertEquals(flipTransform(tile, { left: 32, top: 100, width: 960, height: 640 }), "translate(-22px, -64px) scale(0.1)");
  assertEquals(containBox({ width: 0, height: 5 }, { width: 1, height: 1 }), null);
});

Deno.test("image peek typing guard: text entry keeps Space, other controls do not", () => {
  const input = type => ({ type, matches: selector => selector === "input" });
  assert(typingTarget(input("search")) && typingTarget(input("text")) && typingTarget(input("number")));
  assert(!typingTarget(input("checkbox")) && !typingTarget(input("button")) && !typingTarget(input("range")));
  assert(typingTarget({ matches: selector => selector.includes("textarea") }));
  assert(typingTarget({ isContentEditable: true, matches: () => false }));
  assert(!typingTarget({ matches: () => false }) && !typingTarget(null));
});

Deno.test("image peek owner: hover admission, repeat, switch, release, blur and disposal", () => {
  const host = new EventTarget();
  let changes = 0;
  const peek = makeImagePeek({ changed: () => changes++, host });
  const a = peek.target(() => ({ src: "/a", name: "a" })), b = peek.target(() => ({ src: "/b", full: "/b-full", name: "b" }));
  const empty = peek.target(() => ({ src: "", name: "pending" }));
  const aSurface = element({ left: 1, top: 2, width: 3, height: 4 }), bSurface = element({ left: 5, top: 6, width: 7, height: 8 });
  assert(!peek.admits(key()), "nothing hovered");
  empty.props.onPointerEnter({ currentTarget: element({}) });
  assert(peek.admits(key()), "a tile awaiting its URL can show a loading placeholder");
  assert(peek.start());
  assertEquals(peek.state().target.descriptor().name, "pending"); peek.end();
  a.props.onPointerEnter({ currentTarget: aSurface });
  assert(peek.admits(key()));
  assert(!peek.admits(key({ target: { type: "search", matches: selector => selector === "input" } })), "typing keeps Space");
  assert(!peek.admits(key({ repeat: true })), "a repeat never starts a peek");
  assert(peek.start());
  assertEquals(peek.state().open, true);
  assertEquals(peek.state().target.descriptor().src, "/a");
  assertEquals(peek.state().target.rect(), { left: 1, top: 2, width: 3, height: 4 });
  assert(peek.admits(key({ repeat: true })), "repeats are consumed while held");
  const serial = peek.state().serial;
  assert(peek.start(), "a held peek ignores another start");
  assertEquals(peek.state().serial, serial);
  b.props.onPointerEnter({ currentTarget: bSurface });
  assertEquals(peek.state().target.descriptor().full, "/b-full", "hover while held switches the image");
  b.props.onPointerLeave();
  assertEquals(peek.state().target.descriptor().src, "/b", "leaving every tile keeps the held picture");
  // Release: only Space ends it, and the keyup is consumed (no button activation).
  host.dispatchEvent(Object.assign(new Event("keyup", { cancelable: true }), { key: "a" }));
  assert(peek.state().open);
  const up = Object.assign(new Event("keyup", { cancelable: true }), { key: " " });
  host.dispatchEvent(up);
  assert(up.defaultPrevented && !peek.state().open);
  // Window blur ends a held peek; its listeners are retired afterwards.
  a.props.onPointerEnter({ currentTarget: aSurface });
  assert(peek.start());
  host.dispatchEvent(new Event("blur"));
  assert(!peek.state().open);
  const after = changes;
  host.dispatchEvent(Object.assign(new Event("keyup", { cancelable: true }), { key: " " }));
  assertEquals(changes, after);
  // A retired tile keeps the held picture but has no box to return to.
  assert(peek.start());
  a.retire();
  assertEquals(peek.state().target.rect(), null);
  assert(!peek.admits(key()), "a retired hover cannot start another peek");
  peek.dispose();
  assertEquals(peek.state().open, false);
  b.props.onPointerEnter({ currentTarget: bSurface });
  assert(!peek.admits(key()) && !peek.start(), "a disposed owner admits nothing");
});
