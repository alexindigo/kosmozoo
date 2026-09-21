// tests/t_diff_pair.mjs — the comparator's pair derivation: feed current ×
// right-pane current, workspace-following B, single-image fallback.

import { assertEquals } from "jsr:@std/assert";
import { pairSides } from "../client-solid/features/diff/pair.mjs";

const FEED = { remote: "fake", image: "flux-basic.png" };
const ANCHORS = [{ name: "one.png" }, { name: "two.png" }];
const NODE_IMAGES = [
  { file: "canny.png", fromOutput: false },
  { file: "out.png", fromOutput: true },
];

// --- feed × anchors ----------------------------------------------------------

Deno.test("pair: anchors workspace — B is the selected anchor, else the first", () => {
  assertEquals(
    pairSides({ current: FEED, workspace: "anchors", anchors: ANCHORS, anchorName: null, host: "fake" }),
    { a: { source: "fake", file: "flux-basic.png" }, b: { source: "anchor", file: "one.png" } },
  );
  assertEquals(
    pairSides({ current: FEED, workspace: "anchors", anchors: ANCHORS, anchorName: "two.png", host: "fake" }),
    { a: { source: "fake", file: "flux-basic.png" }, b: { source: "anchor", file: "two.png" } },
  );
});

Deno.test("pair: picking an anchor never touches A (the feed current)", () => {
  const p1 = pairSides({ current: FEED, workspace: "anchors", anchors: ANCHORS, anchorName: null, host: "fake" });
  const p2 = pairSides({ current: FEED, workspace: "anchors", anchors: ANCHORS, anchorName: "two.png", host: "fake" });
  assertEquals(p1.a, p2.a);
});

Deno.test("pair: no feed current → single-image (a is null, the anchor still resolves)", () => {
  assertEquals(
    pairSides({ current: null, workspace: "anchors", anchors: ANCHORS, anchorName: null, host: "fake" }),
    { a: null, b: { source: "anchor", file: "one.png" } },
  );
});

// --- feed × info-pane node images ---------------------------------------------

Deno.test("pair: details workspace — B is the first node image, input-dir bytes", () => {
  assertEquals(
    pairSides({ current: FEED, workspace: "details", anchors: [], nodeImages: NODE_IMAGES, infoFile: null, host: "fake" }),
    { a: { source: "fake", file: "flux-basic.png" }, b: { source: "input:fake", file: "canny.png" } },
  );
});

Deno.test("pair: a node image from the output dir resolves via the host bytes", () => {
  assertEquals(
    pairSides({ current: FEED, workspace: "details", anchors: [], nodeImages: NODE_IMAGES, infoFile: "out.png", host: "fake" }),
    { a: { source: "fake", file: "flux-basic.png" }, b: { source: "fake", file: "out.png" } },
  );
});

Deno.test("pair: details workspace with no node images → single-image (b is null)", () => {
  assertEquals(
    pairSides({ current: FEED, workspace: "details", anchors: [], nodeImages: [], infoFile: null, host: "fake" }),
    { a: { source: "fake", file: "flux-basic.png" }, b: null },
  );
});

Deno.test("pair: a /diff-URL right side keeps its own source (not a node image)", () => {
  // right = another#flux-lora.png — not among the current graph's node images
  assertEquals(
    pairSides({
      current: FEED, workspace: "details", anchors: [], nodeImages: NODE_IMAGES,
      infoFile: "flux-lora.png", infoSource: "another", host: "fake",
    }),
    { a: { source: "fake", file: "flux-basic.png" }, b: { source: "another", file: "flux-lora.png" } },
  );
});
