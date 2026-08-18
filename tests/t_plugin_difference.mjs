// tests/t_plugin_difference.mjs — Phase 11 contract: the difference plugin
// proves the client-only plugin shape (composition registry).

import { assert, assertEquals } from "jsr:@std/assert";

// Minimal client surface mirror — the registry the client host hands out.
const compositionModes = new Map();
const clientHost = {
  composition: (id, def) => compositionModes.set(id, def),
};

// A fake element that records style writes (DOM-free).
function fakeEl() {
  return { style: {}, written: [] };
}

Deno.test("difference plugin: registers a composition mode via the client surface", async () => {
  const mod = await import("../plugins/difference/client.js");
  mod.register(clientHost);
  assert(compositionModes.has("difference"));
  const mode = compositionModes.get("difference");
  assertEquals(typeof mode.apply, "function");
  assertEquals(typeof mode.clear, "function");
});

Deno.test("difference mode: applies mix-blend-mode difference, never through a clip-path", async () => {
  const mod = await import("../plugins/difference/client.js");
  mod.register(clientHost);
  const mode = compositionModes.get("difference");
  const candidate = fakeEl(), anchor = fakeEl();
  mode.apply(candidate, anchor);
  assertEquals(candidate.style.mixBlendMode, "difference");
  assertEquals(candidate.style.clipPath, "none"); // the isolation boundary fix
  assertEquals(anchor.style.opacity, "1");
  // clear restores
  mode.clear(candidate, anchor);
  assertEquals(candidate.style.mixBlendMode, "");
});

Deno.test("difference mode: amplification follow-on sets a brightness/contrast filter", async () => {
  const mod = await import("../plugins/difference/client.js");
  mod.register(clientHost);
  const mode = compositionModes.get("difference");
  const candidate = fakeEl();
  mode.amplify(candidate, 6);
  assertEquals(candidate.style.filter, "brightness(6) contrast(6)");
});
