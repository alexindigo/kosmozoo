import { assertEquals, assertRejects } from "jsr:@std/assert";
import { makePromptLane } from "../src/backings/comfy-submission.mjs";
import { comfyClient } from "../src/backings/comfy.mjs";

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

Deno.test("submission lane gates claims and sends on body completion, not response", async () => {
  const events = [], bodies = [], replies = [];
  const lane = makePromptLane(job => {
    events.push(`send-${job}`);
    const body = deferred(), reply = deferred(); bodies.push(body); replies.push(reply);
    return { sent: body.promise, result: reply.promise };
  });
  const requests = ["a0", "a1", "b0"].map(job => lane.submit(job, { beforeSend() { events.push(`claim-${job}`); } }));
  await new Promise(resolve => setTimeout(resolve, 0));
  assertEquals(events, ["claim-a0", "send-a0"]);
  bodies[0].resolve(true); await requests[0].sent;
  await new Promise(resolve => setTimeout(resolve, 0));
  assertEquals(events, ["claim-a0", "send-a0", "claim-a1", "send-a1"]);
  bodies[1].resolve(true); await requests[1].sent;
  await new Promise(resolve => setTimeout(resolve, 0));
  assertEquals(events, ["claim-a0", "send-a0", "claim-a1", "send-a1", "claim-b0", "send-b0"]);
  bodies[2].resolve(true); replies.forEach(reply => reply.resolve("done"));
  assertEquals(await Promise.all(requests.map(request => request.result)), ["done", "done", "done"]);
});

Deno.test("submission shutdown retires queued jobs before their durable claim", async () => {
  const stop = new AbortController(), body = deferred(), reply = deferred(), claimed = [];
  const lane = makePromptLane(() => ({ sent: body.promise, result: reply.promise }), { signal: stop.signal });
  const first = lane.submit(0, { beforeSend: () => claimed.push(0) });
  const next = lane.submit(1, { beforeSend: () => claimed.push(1) });
  const rejected = assertRejects(() => next.result);
  await new Promise(resolve => setTimeout(resolve, 0)); stop.abort(); body.resolve(false); reply.resolve(null);
  await first.result; await rejected;
  assertEquals(await next.sent, false); assertEquals(claimed, [0]);
});

Deno.test("address binding overlaps slow prompt responses and retains exact bytes and acceptance", async () => {
  const release = deferred(), arrived = [], sent = [], claims = [];
  const ready = deferred();
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async req => {
    const text = await req.text(); arrived.push(text);
    if (arrived.length === 3) ready.resolve();
    await release.promise;
    const index = JSON.parse(text).index;
    return Response.json(index === 0 ? { prompt_id: "first", node_errors: {} } : index === 1 ? { prompt_id: "second", node_errors: { n: {} } } : {});
  });
  const client = comfyClient(`127.0.0.1:${server.addr.port}`);
  try {
    const requests = Array.from({ length: 3 }, (_, index) => client.submit({ index, prompt: { n: { class_type: "Node", is_changed: "old", inputs: { seed: 9007199254740993n } } } }, {
      beforeSend() { claims.push(index); }, onSent() { sent.push(index); },
    }));
    let deadline;
    try { await Promise.race([ready.promise, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("responses blocked the next send")), 2000); })]); }
    finally { clearTimeout(deadline); }
    assertEquals(claims, [0, 1, 2]); assertEquals(sent, [0, 1, 2]);
    assertEquals(arrived.map(text => JSON.parse(text).index), [0, 1, 2]);
    assertEquals(arrived.every(text => text.includes('9007199254740993') && !text.includes('is_changed')), true);
    release.resolve();
    assertEquals((await Promise.all(requests.map(request => request.result))).map(result => [result.acceptance, result.sent]), [["confirmed", true], ["partial", true], ["uncertain", true]]);
  } finally { release.resolve(); await client.disposeInventory(); await server.shutdown(); }
});
