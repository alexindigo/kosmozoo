import { assert, assertEquals } from "jsr:@std/assert";
import { mediaFailure } from "../client-solid/store/media-failure.js";

Deno.test("media failures preserve known decode causes without guessing unknown failures", () => {
  for (const kind of ["video", "audio"]) {
    for (const code of [3, 4]) assertEquals(mediaFailure(kind, code), `Your browser can't play this ${kind} format.`);
    for (const code of [false, undefined, 1, 2, "unknown"]) assertEquals(mediaFailure(kind, code), "Can't display this file.");
  }
  assertEquals(mediaFailure("image", "decode"), "This image can't be decoded.");
  assertEquals(mediaFailure("image", false), "Can't display this file.");
});

Deno.test("media styles use semantic tokens, and all playback buttons use the shared library", async () => {
  const css = await Deno.readTextFile(new URL("../client/css/app.css", import.meta.url));
  const mediaRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selector]) => /\.media-|\.votebtn\.(play|prominent)/.test(selector));
  assert(mediaRules.length > 10);
  for (const [rule] of mediaRules) assert(!/#[\da-f]{3,8}\b/i.test(rule), rule);
  for (const file of ["MediaControls.tsx", "MediaBox.tsx"]) {
    const source = await Deno.readTextFile(new URL(`../client-solid/components/${file}`, import.meta.url));
    assert(!/<button\b/.test(source), file);
    assert(source.includes("<IconButton"), file);
  }
});
