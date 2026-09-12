// tests/t_writer.mjs — the serialized JSON writer: per-path ordering,
// coalescing under a write storm (last value wins, renames bounded),
// chain survives a failed write.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { SerializedWriter } from "../src/writer.mjs";
import { Settings } from "../src/settings.mjs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const enc = (s) => new TextEncoder().encode(s);

Deno.test("writer: 50 concurrent writes coalesce — last value wins, ≤2 renames", async () => {
  const path = "/mem/settings.json";
  let renames = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const contents = new Map();
  const slowWrite = async (p, bytes) => {
    if (renames === 0) await gate; // hold the in-flight write open
    renames++;
    contents.set(p, new TextDecoder().decode(bytes));
  };

  const w = new SerializedWriter(path, slowWrite);
  const first = w.write(enc(JSON.stringify({ v: 1 })));
  await Promise.resolve(); // let the first write take its payload and block
  const rest = [];
  for (let i = 2; i <= 50; i++) rest.push(w.write(enc(JSON.stringify({ v: i }))));
  release();
  await Promise.all([first, ...rest]);

  assert(renames <= 2, `expected ≤2 renames for 50 queued writes, got ${renames}`);
  assertEquals(JSON.parse(contents.get(path)), { v: 50 });
});

Deno.test("writer: sequential awaited writes land in order", async () => {
  const order = [];
  const w = new SerializedWriter("/mem/x", async (_p, bytes) => {
    order.push(new TextDecoder().decode(bytes));
  });
  for (let i = 1; i <= 5; i++) await w.write(enc(String(i)));
  assertEquals(order, ["1", "2", "3", "4", "5"]);
});

Deno.test("writer: a failed write rejects its caller, the chain survives", async () => {
  let fail = true;
  const landed = [];
  const w = new SerializedWriter("/mem/y", async (_p, bytes) => {
    if (fail) throw new Error("disk full");
    landed.push(new TextDecoder().decode(bytes));
  });
  await assertRejects(() => w.write(enc("doomed")), Error, "disk full");
  fail = false;
  await w.write(enc("fine"));
  assertEquals(landed, ["fine"]);
});

Deno.test("settings: 50 concurrent set() — file parses, last value wins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-writer-"));
  const s = await Settings.open(dir);
  await Promise.all(
    Array.from({ length: 50 }, (_, i) => s.set("core.race", "k", i)),
  );
  const doc = JSON.parse(await readFile(join(dir, "settings.json"), "utf-8"));
  assertEquals(doc.data["core.race"].k, 49);
  // and a reopened Settings sees the same (nothing half-written)
  const s2 = await Settings.open(dir);
  assertEquals(s2.get("core.race", "k"), 49);
  await rm(dir, { recursive: true });
});
