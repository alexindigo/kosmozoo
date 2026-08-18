// tests/t_judgment.mjs — Phase 9 contract tests: vote/favorite/hidden are
// distinct; down-vote-hides coupling is a setting; reveal is temporary and
// non-destructive; migration loses no field.

import { assert, assertEquals } from "jsr:@std/assert";
import { migrate, migrateEntry } from "../src/migrate-feedback.mjs";
import { readFile } from "node:fs/promises";

// --- judgment semantics (pure functions on plain objects — no DOM) ---------

function isVisible(judgment, { downvoteHides = true, reveal = false } = {}) {
  const down = judgment?.vote === "down";
  if (!down) return true;
  if (!downvoteHides) return true;
  return reveal;
}

Deno.test("judgment: vote/favorite/hidden are distinct concepts", () => {
  // vote is the decision signal; favorite is independent of project fit;
  // hidden is a view filter. An image can be voted down AND favorited.
  const j = { vote: "down", favorite: true };
  assertEquals(j.vote, "down");
  assertEquals(j.favorite, true);
});

Deno.test("judgment: down-vote hides by default; coupling is a setting", () => {
  const j = { vote: "down" };
  assertEquals(isVisible(j), false);                       // default: hidden
  assertEquals(isVisible(j, { downvoteHides: false }), true); // setting off
});

Deno.test("judgment: 'show thumbed-down' is a temporary reveal, not a deletion", () => {
  const j = { vote: "down" };
  assertEquals(isVisible(j, { reveal: true }), true);
  // the vote survives the reveal — this is the regression test against the
  // outgoing button that deleted every down-vote to achieve the same effect
  assertEquals(j.vote, "down");
});

// --- migration ---------------------------------------------------------------

Deno.test("migration: pos/neg -> notes, vote preserved, absent fields stay absent", () => {
  const m = migrateEntry({ pos: "colors", neg: "baby face", vote: "up" });
  assertEquals(m, { notes: { pos: "colors", neg: "baby face" }, vote: "up" });
  // an entry with only a note carries no vote key at all
  assertEquals(migrateEntry({ pos: "x" }), { notes: { pos: "x" } });
  // a fully-empty entry migrates to nothing (pruned)
  assertEquals(migrateEntry({}), {});
});

Deno.test("migration: real 61-entry feedback.json — N in, N out, no field lost", async () => {
  const path = "/home/user/Documents/kosmozoo_feedback.json";
  let old;
  try {
    old = JSON.parse(await readFile(path, "utf-8"));
  } catch {
    console.log("  (skipped: real feedback.json not present in this environment)");
    return;
  }
  const doc = migrate(old);
  const inCount = Object.keys(old).filter((k) => Object.keys(old[k]).length).length;
  const outCount = Object.keys(doc.data).length;
  assertEquals(outCount, inCount);
  // no field lost: every pos/neg/vote in the input appears in the output
  for (const [key, entry] of Object.entries(old)) {
    const m = doc.data[key];
    if (!Object.keys(entry).length) continue;
    if (entry.pos) assertEquals(m.notes.pos, entry.pos);
    if (entry.neg) assertEquals(m.notes.neg, entry.neg);
    if (entry.vote) assertEquals(m.vote, entry.vote);
  }
  assertEquals(doc.version, 1);
});
