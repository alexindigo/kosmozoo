import { assertEquals, assertThrows } from "jsr:@std/assert";
import { validateGraphLinks, dependencyClosure } from "../src/graph.mjs";
import { typedRunRig } from "./helpers/typed-run.mjs";
import { parseExactJson } from "../src/parameters.mjs";

Deno.test("typed graph: known output slots and union input types validate through the graph owner", () => {
  const graph = { source: { class_type: "Source", inputs: {} }, sink: { class_type: "Sink", inputs: { value: ["source", 0] } } };
  const schema = { declarations: new Map([["Sink.value", { type: "INT,STRING" }]]), outputs: new Map([["Source", [{ type: "STRING" }]]]) };
  validateGraphLinks(graph, schema);
  graph.sink.inputs.value[1] = 1;
  assertThrows(() => validateGraphLinks(graph, schema), Error, "slot");
  graph.sink.inputs.value[1] = 0; schema.outputs.get("Source")[0].type = "IMAGE";
  assertThrows(() => validateGraphLinks(graph, schema), Error, "type");
});

Deno.test("typed connection Run: real retarget, known later invalid slot/type and literal-array transport", async () => {
  const graph = { first: { class_type: "Source", inputs: {} }, second: { class_type: "Source", inputs: {} },
    sink: { class_type: "Sink", inputs: { value: ["first", 0], literal: { __value__: [] } } },
    save: { class_type: "SaveImage", inputs: { filename_prefix: "source", images: ["sink", 0] } } };
  const schema = { declarations: new Map([["Sink.value", { type: "IMAGE" }]]), outputs: new Map([["Source", [{ type: "IMAGE" }, { type: "STRING" }]]]) };
  const rig = typedRunRig({ graph, schema });
  const body = await rig.request({ "sink.value": { enabled: true, values: [["second", 0]] }, "sink.literal": { enabled: true, values: [[true, null, 3]] } });
  assertEquals((await rig.run(body)).status, 200);
  const sent = parseExactJson(rig.bytes[0]).prompt;
  assertEquals(sent.sink.inputs.value, ["second", 0]);
  assertEquals(sent.sink.inputs.literal, { __value__: [true, null, 3] });
  assertEquals([...dependencyClosure(sent, "save")], ["save", "sink", "second"]);
  for (const invalid of [["second", 2], ["second", 1], ["missing", 0]]) {
    const fresh = typedRunRig({ graph, schema });
    const body = await fresh.request({ "sink.value": { enabled: true, values: [["second", 0], invalid] } });
    assertEquals((await fresh.run(body)).status, 400); assertEquals(fresh.bytes, []);
  }
});

Deno.test("typed graph: wrappers are literal data and lazy closure semantics are unchanged", () => {
  const graph = { source: { inputs: {} }, sink: { inputs: { value: { __value__: ["missing", 9] }, lazy: ["source", 0] } } };
  validateGraphLinks(graph);
  assertEquals([...dependencyClosure(graph, "sink")], ["sink", "source"]);
  graph.sink.inputs.value = ["source", -1];
  assertThrows(() => validateGraphLinks(graph), Error, "array");
});
