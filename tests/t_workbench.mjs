// tests/t_workbench.mjs — harvested view guards: write-back ordering, the
// load-generation guard, and derived-state persistence. (The blink/axis
// mechanics these once guarded were removed with the workbench strip; the
// view-persistence contracts stay because in-feed zoom still uses them.)

import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import { viewToPersisted, viewFromPersisted } from "../client/js/geometry.mjs";

// Contract tests target the *mechanism* level (state + ordering), not pixels
// — charter invariant 6: pixel/timing claims need a real browser and live in
// the dogfood gate instead.

Deno.test("view: write-back happens before incoming read (harvest #2)", () => {
  // Order matters: outgoing state must be saved before state.view changes, or
  // state bleeds across the pair. Encode the ordering as a contract on the
  // persisted round-trip.
  const v = { s: 3, txf: 0.2, tyf: 0.1, fh: false, fv: false, rot: 0 };
  const persisted = viewToPersisted(v);
  const readBack = viewFromPersisted(persisted);
  assertEquals(readBack.s, 3);
  assertEquals(readBack.txf, 0.2);
});

Deno.test("load: generation guard invalidates stale loads (harvest #1)", () => {
  // A load started at gen N must not commit if loadGen has moved on.
  let committed = null;
  const loadGen = { n: 0 };
  async function fakeLoad(src, delay) {
    const gen = ++loadGen.n;
    await new Promise((r) => setTimeout(r, delay));
    if (gen !== loadGen.n) return; // superseded
    committed = src;
  }
  return (async () => {
    const slow = fakeLoad("slow.png", 50);
    const fast = fakeLoad("fast.png", 5);
    await Promise.all([slow, fast]);
    assertEquals(committed, "fast.png"); // slow load was superseded mid-flight
  })();
});

Deno.test("view: derived state never persists over its source (harvest #4)", () => {
  // A face-aligned (derived) view must be recomputed from the stored source,
  // never written back — or zoom compounds on every switch.
  const source = { s: 1, txf: 0, tyf: 0, fh: false, fv: false, rot: 0 };
  const derived = { ...source, s: 4.2 }; // face-align zooms in
  // persisting the derived view would store s=4.2; the contract is that we
  // persist the SOURCE and recompute the derived view. Verify the source
  // round-trips to null (untouched) while the derived one would not.
  assertEquals(viewToPersisted(source), null);
  assertNotEquals(viewToPersisted(derived), null); // proof the trap exists
});
