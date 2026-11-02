import { assert, assertEquals } from "jsr:@std/assert";
import { WorkflowProgress } from "../src/workflow-progress.mjs";
import { comfyClient } from "../src/backings/comfy.mjs";
import { Jobs } from "../src/jobs.mjs";

const fixture = JSON.parse(await Deno.readTextFile(new URL("./fixtures/workflow-progress.json", import.meta.url)));
const backing = comfyClient("recorded:1", { fetcher: async () => Response.json(fixture.objectInfo) });
const info = await backing.objectInfo();
await backing.disposeInventory();
function replay(name) {
  const data = fixture.cases[name], m = new WorkflowProgress();
  m.configure(data.messages[0]?.data.prompt_id ?? "foreign", data); m.info = info;
  return { data, m };
}

Deno.test("recorded ComfyUI: plain chain has a static denominator, including before future nodes appear", () => {
  const { data, m } = replay("plain-chain");
  assertEquals(fixture.comfyCommit, "35060f0156181ae78a86b10f098f67ce8e83697f");
  const expected = [0, 1, 1, 2, 2];
  data.messages.forEach((message, index) => {
    m.receive(message);
    const w = m.workflow(); assertEquals(w.total, 3);
    if (index < expected.length) assertEquals(w.done, expected[index]);
    else { assert(w.done < 3); assert(w.done > 2.999); }
  });
});

Deno.test("recorded ComfyUI: cached prefix has no cached events and starts four of five nodes done", () => {
  const { data, m } = replay("cached-prefix");
  assertEquals(data.messages.map(message => message.type), ["progress_state", "progress_state"]);
  assertEquals(Object.keys(data.messages[0].data.nodes), ["3"]);
  m.receive(data.messages[0]);
  assertEquals(m.workflow().done, 4); assertEquals(m.workflow().total, 5); assertEquals(m.workflow().fraction, .8);
});

Deno.test("recorded ComfyUI: lazy Switch never certifies its cached lazy branch ancestors", () => {
  const { data, m } = replay("lazy-switch");
  assertEquals([...info.lazyInputs.get("ComfySwitchNode")], ["on_false", "on_true"]);
  const expected = [0, 0, 1, 1, 2];
  data.messages.forEach((message, index) => {
    m.receive(message); assertEquals(m.workflow().total, 6); assertEquals(m.workflow().done, expected[index]);
  });
});

Deno.test("recorded ComfyUI: fractional work, monotonic counter resets and nodes outside S", () => {
  const { data, m } = replay("broadcast-batch");
  const sample = data.messages.find(message => message.type === "progress_state" && message.data.nodes["5"]?.value === 14);
  m.receive(sample); assertEquals(m.workflow().done, 3 + 14 / 32); assertEquals(m.workflow().fraction, .6875);
  const reset = structuredClone(sample); reset.data.nodes["5"].value = 0;
  m.receive(reset); assertEquals(m.workflow().fraction, .6875);
  const expanded = structuredClone(sample);
  expanded.data.nodes["runtime-expanded.1"] = { ...expanded.data.nodes["5"], state: "finished", value: 32 };
  m.receive(expanded); assertEquals(m.workflow().total, 5); assertEquals(m.workflow().fraction, .6875);
  let previous = 0;
  for (const message of data.messages) {
    m.receive(message); const w = m.workflow();
    assert(w.fraction >= previous && w.fraction < 1); previous = w.fraction;
  }
  const foreign = replay("foreign-client"); assertEquals(foreign.data.messages, []); assertEquals(foreign.m.workflow(), null);
});

Deno.test("native ComfyUI socket: recorded events reach Jobs, preview frames are ignored, reconnect restores enrichment", async () => {
  const data = fixture.cases["broadcast-batch"], prompt = data.messages[0].data.prompt_id;
  const sockets = [], clientIds = []; let sends = 0, running = true, finished = false;
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, req => {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onopen = () => { sockets.push(socket); clientIds.push(url.searchParams.get("clientId")); };
      socket.onmessage = () => sends++;
      return response;
    }
    if (url.pathname === "/api/queue") return Response.json({
      queue_running: running ? [[0, prompt, data.graph, {}, data.outputs]] : [], queue_pending: [] });
    if (url.pathname.startsWith("/api/history")) return Response.json(finished ? {
      [prompt]: { status: { completed: true, status_str: "success", messages: [] } },
    } : {});
    if (url.pathname === "/api/object_info") return Response.json(fixture.objectInfo);
    if (url.pathname === "/internal/logs/raw") return Response.json({ entries: [], size: 0 });
    return new Response("not found", { status: 404 });
  });
  const address = `127.0.0.1:${server.addr.port}`, client = comfyClient(address);
  let terminalSnapshot;
  const jobs = new Jobs({ hosts: { real: address, alias: address }, client: () => client,
    onFinish: (_address, _sources, snapshot) => terminalSnapshot = snapshot });
  async function until(test) {
    const end = Date.now() + 5000;
    while (Date.now() < end) { if (test()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
    throw new Error("native socket condition timed out");
  }
  try {
    jobs.start(); await jobs.tick(); await until(() => sockets.length === 1);
    const sample = data.messages.find(message => message.type === "progress_state" && message.data.nodes["5"]?.value === 14);
    const progress = data.messages.find(message => message.type === "progress" && message.data.value === 14);
    sockets[0].send(new Uint8Array([0, 0, 0, 1, 255])); sockets[0].send("bad-json");
    sockets[0].send(JSON.stringify(sample)); sockets[0].send(JSON.stringify(progress));
    await until(() => jobs.snapshot("real").progressBasis === "exact" && jobs.snapshot("real").workflow !== null);
    assertEquals(jobs.snapshot("real").workflow.fraction, .6875);
    assertEquals(jobs.snapshot("real").progress.fraction, 14 / 32);
    assertEquals(jobs.snapshot("alias"), jobs.snapshot("real")); assertEquals(sends, 0);
    assert(clientIds[0] && clientIds[0] !== prompt);
    sockets[0].close(); await until(() => jobs.snapshot("real").workflow === null);
    assertEquals(jobs.snapshot("real").state, "running");
    await until(() => sockets.length === 2);
    sockets[1].send(JSON.stringify(sample)); await until(() => jobs.snapshot("real").workflow !== null);
    assertEquals(jobs.snapshot("real").workflow.fraction, .6875);
    running = false; finished = true; await jobs.tick();
    assertEquals(jobs.snapshot("real").state, "idle"); assertEquals(jobs.snapshot("real").workflow, null);
    assertEquals(jobs.snapshot("real").terminalRevision, 1);
    assertEquals(terminalSnapshot, jobs.snapshot("real"), "finish consumers see the installed projection, including retired enrichment");
  } finally { await jobs.stop(); await client.disposeInventory(); await server.shutdown(); }
});
