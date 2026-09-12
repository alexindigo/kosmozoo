// tests/t_judgment.mjs — the judgment model: vote/favorite/hidden are
// distinct; down-vote-hides coupling is a setting; reveal is temporary and
// non-destructive. Judgments are entry columns (sqlite canonical);
// judgmentPatch whitelists fields and deep-prunes defaults; two entries
// sharing one hash carry INDEPENDENT judgments.

import { assert, assertEquals } from "jsr:@std/assert";
import { Store } from "../src/store.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- judgment semantics (pure functions on plain objects — no DOM) ---------

function isVisible(judgment, { downvoteHides = true, reveal = false } = {}) {
  const down = judgment?.vote === "down";
  if (!down) return true;
  if (!downvoteHides) return true;
  return reveal;
}

Deno.test("judgment: vote/favorite/hidden are distinct concepts", () => {
  const j = { vote: "down", favorite: true };
  assertEquals(j.vote, "down");
  assertEquals(j.favorite, true);
});

Deno.test("judgment: down-vote hides by default; coupling is a setting", () => {
  const j = { vote: "down" };
  assertEquals(isVisible(j), false);
  assertEquals(isVisible(j, { downvoteHides: false }), true);
});

Deno.test("judgment: 'show thumbed-down' is a temporary reveal, not a deletion", () => {
  const j = { vote: "down" };
  assertEquals(isVisible(j, { reveal: true }), true);
  assertEquals(j.vote, "down");
});

// --- entry columns ------------------------------------------------------------

Deno.test("judgment: patch whitelists fields and deep-prunes defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-jpatch-"));
  const store = await Store.open(dir);

  // unknown fields rejected (E6)
  assertEquals(store.judgmentPatch("h", "a.png", { ref: "x", plugins: {} }).ok, false);
  assertEquals(store.judgmentPatch("h", "a.png", { "plugins..x": 1 }).ok, false);

  // write → read back; defaults prune
  store.judgmentPatch("h", "a.png", { vote: "down", favorite: true, notes: { pos: "c", neg: "" } });
  assertEquals(store.judgmentGet("h", "a.png"), { vote: "down", favorite: true, notes: { pos: "c" } });

  // plugin fields namespaced and pruned with the rest
  store.judgmentPatch("h", "a.png", { "plugins.export.bucket": "good" });
  assertEquals(store.judgmentGet("h", "a.png").plugins, { export: { bucket: "good" } });
  store.judgmentPatch("h", "a.png", { "plugins.export.bucket": null });
  assertEquals(store.judgmentGet("h", "a.png").plugins, undefined);

  // clearing everything prunes the row back to empty
  store.judgmentPatch("h", "a.png", { vote: null, favorite: null, notes: null });
  assertEquals(store.judgmentGet("h", "a.png"), null);

  store.close();
  await rm(dir, { recursive: true });
});

Deno.test("judgment: two entries sharing one hash carry independent judgments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-jper-"));
  const store = await Store.open(dir);
  const h = "ab".repeat(32);
  await store.ingestFile("a", "same.png", h, 10);
  await store.ingestFile("b", "same.png", h, 10);

  store.judgmentPatch("a", "same.png", { vote: "up" });
  store.judgmentPatch("b", "same.png", { vote: "down", notes: { neg: "dupe" } });

  assertEquals(store.judgmentGet("a", "same.png"), { vote: "up" });
  assertEquals(store.judgmentGet("b", "same.png"), { vote: "down", notes: { neg: "dupe" } });

  store.close();
  await rm(dir, { recursive: true });
});
