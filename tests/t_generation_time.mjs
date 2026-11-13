import { assertEquals } from "jsr:@std/assert";
import { makeGenerationTimes } from "../src/backings/comfy-generation.mjs";
import { comfyClient } from "../src/backings/comfy.mjs";
import { fmtGenerationTime } from "../client-solid/store/fields.js";

const job = (id, name = "dir/image.png", start = 1000, end = 141138) => {
  const parts = name.split("/"), filename = parts.pop();
  return { outputs: { "9": { images: [{ filename, subfolder: parts.join("/"), type: "output" }] } },
    status: { completed: true, status_str: "success", messages: [
      ["execution_start", { prompt_id: id, timestamp: start }],
      ["execution_success", { prompt_id: id, timestamp: end }],
    ] } };
};

Deno.test("generation time: exact output path and matching execution timestamps, not queue time", () => {
  const times = makeGenerationTimes();
  times.observe({ one: job("one"), two: job("two", "other/image.png", 2000, 2000) });
  assertEquals(times.read("dir/image.png"), 140138);
  assertEquals(times.read("other/image.png"), 0);
  assertEquals(times.read("image.png"), null);
  assertEquals(times.read("unknown.png"), null);
});

Deno.test("generation time: absent, malformed, foreign, reversed and unsuccessful timing stays unavailable", () => {
  for (const mutate of [
    e => { e.status.messages = []; },
    e => { e.status.messages[0][1].timestamp = "1000"; },
    e => { e.status.messages[1][1].timestamp = NaN; },
    e => { e.status.messages[0][1].prompt_id = "foreign"; },
    e => { e.status.messages[1][1].timestamp = 999; },
    e => { e.status.messages.push(e.status.messages[0]); },
    e => { e.status.completed = false; },
    e => { e.status.status_str = "error"; },
    e => { e.outputs["9"].images[0].type = "input"; },
    e => { e.outputs["9"].images[0].subfolder = "../dir"; },
  ]) {
    const times = makeGenerationTimes(), entry = job("one"); mutate(entry);
    times.observe({ one: entry }); assertEquals(times.read("dir/image.png"), null);
  }
});

Deno.test("generation time: repeated observation is idempotent; ambiguous output producers never pick newest", () => {
  const times = makeGenerationTimes();
  times.observe({ one: job("one") }); times.observe({ one: job("one") });
  assertEquals(times.read("dir/image.png"), 140138);
  times.observe({ two: job("two", "dir/image.png", 200000, 230000) });
  assertEquals(times.read("dir/image.png"), null);
  times.observe({}); assertEquals(times.read("dir/image.png"), null);
  times.clear(); assertEquals(times.read("dir/image.png"), null);
});

Deno.test("generation time: optional history evidence uses the existing binding and coalesces cold reads", async () => {
  let calls = 0;
  const client = comfyClient("fake:8188", { fetcher: async url => {
    assertEquals(new URL(url).pathname, "/api/history"); calls++;
    return Response.json({ one: job("one") });
  } });
  assertEquals(await Promise.all([client.generationTime("dir/image.png"), client.generationTime("unknown.png")]), [140138, null]);
  assertEquals(calls, 1);
  assertEquals(await client.generationTime("dir/image.png"), 140138);
  await client.disposeInventory();
  assertEquals(await client.generationTime("dir/image.png"), null);
  assertEquals(calls, 1);
});

Deno.test("generation time: ordinary history reads seed timing without changing telemetry's public shape", async () => {
  let calls = 0;
  const client = comfyClient("fake:8188", { fetcher: () => { calls++; return Promise.resolve(Response.json({ one: job("one") })); } });
  assertEquals(await client.history(), [{ id: "one", terminal: true, outcome: "success" }]);
  assertEquals(await client.generationTime("dir/image.png"), 140138);
  assertEquals(calls, 1);
  await client.disposeInventory();
});

Deno.test("generation time: retired binding cannot publish a late history read", async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const client = comfyClient("fake:8188", { fetcher: () => held });
  const pending = client.generationTime("dir/image.png");
  await client.disposeInventory();
  release(Response.json({ one: job("one") }));
  assertEquals(await pending, null);
});

Deno.test("generation time: formatting keeps missing distinct from zero and uses compact elapsed units", () => {
  for (const value of [undefined, null, -1, NaN, Infinity, "1000"]) assertEquals(fmtGenerationTime(value), "--");
  assertEquals(fmtGenerationTime(0), "0s");
  assertEquals(fmtGenerationTime(138), "0.14s");
  assertEquals(fmtGenerationTime(140138), "2m 20s");
  assertEquals(fmtGenerationTime(3600000), "1h 0m 0s");
});
