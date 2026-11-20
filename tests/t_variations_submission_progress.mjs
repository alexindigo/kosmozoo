import { assertEquals } from "jsr:@std/assert";
import { observeSubmission } from "../client-solid/features/variations/submission-progress.js";
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

Deno.test("submission progress is single-flight, polls at 500ms and stops without late publication", async () => {
  const timers = new Map(), values = [], reads = [], gates = [];
  const stop = observeSubmission({
    read(signal) { const gate = deferred(); gates.push(gate); reads.push(signal); return gate.promise; },
    publish(value) { values.push(value); },
    setTimer(callback, delay) { assertEquals(delay, 500); timers.set(1, callback); return 1; },
    clearTimer(id) { timers.delete(id); },
  });
  await tick(); assertEquals(reads.length, 1); assertEquals(timers.size, 0);
  gates[0].resolve({ sent: 2, total: 6 }); await tick();
  assertEquals(values, [{ sent: 2, total: 6 }]); assertEquals(timers.size, 1);
  timers.get(1)(); timers.clear(); await tick(); assertEquals(reads.length, 2);
  const stopped = stop(); assertEquals(reads[1].aborted, true);
  gates[1].resolve({ sent: 6, total: 6 }); await stopped; await tick();
  assertEquals(values, [{ sent: 2, total: 6 }]); assertEquals(timers.size, 0);
});

Deno.test("submission progress read failure clears unavailable facts and never retries effects", async () => {
  let callback, reads = 0; const values = [];
  const stop = observeSubmission({ read() { reads++; throw new Error("unavailable"); }, publish: value => values.push(value),
    setTimer(fn) { callback = fn; return 1; }, clearTimer() { callback = null; } });
  await tick(); assertEquals(values, [null]); assertEquals(reads, 1);
  await stop(); assertEquals(callback, null);
});
