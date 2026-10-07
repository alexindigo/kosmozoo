import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import { finalizeInventory, compareInventory, validateModified } from "../src/backings/inventory.mjs";
import { parseHttpDate, interpretHeaders } from "../src/backings/comfy-metadata.mjs";

const record = (name, atMs) => ({ name, size: 12, modified: { atMs, precisionMs: 1000, source: "http-last-modified" } });
const candidate = (records, unavailable = []) => ({ records, discovered: [...records, ...unavailable].map((r) => r.name), unavailable,
  coverage: "recursive", subfolders: { supported: true, reason: null } });

Deno.test("inventory contract: one transitive chronology, exact path ties, zero/pre-epoch and immutable inputs", () => {
  const input = [record("root-old.png", -1000), record("z/new.png", 2000), record("a/new.png", 2000), record("zero.png", 0)];
  const original = JSON.stringify(input);
  const snapshot = finalizeInventory(candidate(input));
  assertEquals(snapshot.items.map((r) => r.name), ["a/new.png", "z/new.png", "zero.png", "root-old.png"]);
  assertEquals(JSON.stringify(input), original);
  assert(Object.isFrozen(snapshot.items[0].modified));
  assertThrows(() => snapshot.items.push(record("illegal.png", 1)));
  assertThrows(() => snapshot.items[0].modified.atMs = 9);
  assertEquals(snapshot.chronology, { order: "modified-desc", complete: true });
  const a = record("a.png", 1), b = record("b.png", 1.001), c = record("c.png", 1.002);
  assert(compareInventory(a, b) > 0 && compareInventory(b, c) > 0 && compareInventory(a, c) > 0);
});

Deno.test("inventory contract: conflicting duplicates/time units/undated records reject, unavailable ancestors remain", () => {
  assertThrows(() => finalizeInventory(candidate([record("a.png", 0), record("a.png", 1)])));
  assertThrows(() => validateModified({ atMs: "1000", precisionMs: 1000, source: "http-last-modified" }));
  assertThrows(() => validateModified({ atMs: NaN, precisionMs: null, source: "filesystem-stat" }));
  assertThrows(() => finalizeInventory(candidate([{ name: "a.png", size: 0, modified: null }])));
  const snapshot = finalizeInventory(candidate([record("root.png", 0)], [{ name: "empty/deep/missing.png", status: 404, reason: "source-not-found" }]));
  assertEquals(snapshot.folders, ["", "empty", "empty/deep"]);
  assertEquals(snapshot.items.length, 1);
  assertEquals(snapshot.unavailable[0].name, "empty/deep/missing.png");
  assert(Object.isFrozen(snapshot.unavailable[0]));
});

Deno.test("HTTP time contract: explicit IMF date validation and independent opaque validator", () => {
  assertEquals(parseHttpDate("Thu, 01 Jan 1970 00:00:00 GMT"), 0);
  assertEquals(parseHttpDate("Wed, 31 Dec 1969 23:59:59 GMT"), -1000);
  for (const bad of ["1", "1000", "2026-10-06", "Tue, 30 Feb 2026 00:00:00 GMT", "Fri, 01 Jan 1970 00:00:00 GMT", null]) assertEquals(parseHttpDate(bad), null);
  const header = interpretHeaders(new Response(null, { headers: { ETag: '"not-a-time"', "Content-Length": "0" } }));
  assertEquals(header, { stamp: '"not-a-time"', size: 0, modified: null });
  assert(Number.isNaN(interpretHeaders(new Response(null, { headers: { "Content-Length": "-1" } })).size));
});
