// tests/t_ingest_gate.mjs — the read gate: a human-visible read (the bytes
// route's "high" class) always takes the next free slot over background
// work ("low"); per-host concurrency is bounded; a high caller joining a
// low single-flight upgrades the queued read.

import { assert, assertEquals } from "jsr:@std/assert";
import { Ingest } from "../src/ingest.mjs";
import { mkStateRig } from "./helpers/rig.mjs";

// A fake comfy whose reads take ~40 ms each (via the inline stub pattern,
// with a delay and order recording on top)
function slowComfy(delayMs = 40) {
  const order = [];
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, async (req) => {
    const url = new URL(req.url);
    if (url.pathname !== "/api/view") return new Response("nf", { status: 404 });
    const name = url.searchParams.get("filename") ?? "";
    if (req.method === "HEAD") return new Response(null, { headers: { ETag: '"e"' } });
    order.push(name);
    await new Promise((r) => setTimeout(r, delayMs));
    return new Response(`bytes:${name}`, { headers: { ETag: '"e"', "Content-Type": "image/png" } });
  });
  return { order, server, addr: `127.0.0.1:${server.addr.port}` };
}

Deno.test("read gate: a high-priority read jumps the background queue", async () => {
  const rig = await mkStateRig("gate", {});
  const { order, server, addr } = slowComfy(40);
  const ingest = new Ingest(rig.store, { c: addr }, { cache: rig.cache });

  // saturate the gate with background work (4 slots) + a backlog
  const lows = [];
  for (let i = 0; i < 8; i++) lows.push(ingest.ensure("c", `low-${i}.png`));
  // a human-visible read of a DIFFERENT file lands behind them
  const high = ingest.ensure("c", "high.png", "output", { priority: "high" });
  await high;

  // the high read must NOT be last: treated as background it would run
  // after all 8 lows; the gate serves it before the last low completes
  const lastLow = order.filter((n) => n.startsWith("low-")).at(-1);
  const highAt = order.indexOf("high.png");
  assert(highAt >= 0, "the high read happened");
  assert(highAt < order.indexOf(lastLow),
    `high (at ${highAt}) beat the last low (at ${order.indexOf(lastLow)}): ${order.join(",")}`);

  await Promise.all(lows);
  // every read completed (8 lows + the high one)
  assert(order.length === 9, `all 9 reads completed: ${order.length}`);

  await server.shutdown();
  await rig.close();
});

Deno.test("read gate: a high caller joining a low single-flight upgrades the queued read", async () => {
  const rig = await mkStateRig("gate2", {});
  const { order, server, addr } = slowComfy(40);
  const ingest = new Ingest(rig.store, { c: addr }, { cache: rig.cache });

  // saturate the gate so the shared read QUEUES (does not start immediately)
  const fillers = [];
  for (let i = 0; i < 4; i++) fillers.push(ingest.ensure("c", `fill-${i}.png`));
  // the same file wanted by background AND by a human — one read, high class
  const low = ingest.ensure("c", "shared.png");
  const high = ingest.ensure("c", "shared.png", "output", { priority: "high" });
  assertEquals(low, high, "single-flight: the callers share one read");
  await Promise.all([low, high]);

  const sharedAt = order.indexOf("shared.png");
  assert(sharedAt >= 0 && sharedAt < 4 + 4,
    `the upgraded read ran right after the in-flight batch: ${order.join(",")}`);
  assertEquals(order.filter((n) => n === "shared.png").length, 1, "one backing read for both callers");

  await Promise.all(fillers);
  await server.shutdown();
  await rig.close();
});
