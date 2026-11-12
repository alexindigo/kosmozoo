import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import * as values from "../src/parameters.mjs";
import * as shared from "../src/features/variations/shared.mjs";
const { generatePermutations, permutationPlan, formatValue } = shared;
import { typedRunRig } from "./helpers/typed-run.mjs";
import { metaFromBytes } from "../src/extractor.mjs";
import { testPng } from "./helpers/png.mjs";
import { objectInfo } from "../src/backings/comfy.mjs";
import { compileDiscreteAxes } from "../src/features/variations/compile.mjs";

const graph = { node: { class_type: "Custom", inputs: { flag: false, nullable: "original", data: {}, array: { __value__: [] },
  max: 18446744073709551615n, next: 9007199254740992n, untouched: 9007199254740993n, previous: 9007199254740992n } },
  save: { class_type: "SaveImage", inputs: { filename_prefix: "source", images: ["node", 0] } } };

Deno.test("typed Run: exact final request bytes preserve originals and whole assigned values with v2 proof", async () => {
  // Fixture serialization is native numeric JSON, independently of the codec.
  const wireGraph = { ...graph, node: { ...graph.node, inputs: { ...graph.node.inputs,
    max: JSON.rawJSON("18446744073709551615"), next: JSON.rawJSON("9007199254740992"),
    untouched: JSON.rawJSON("9007199254740993"), previous: JSON.rawJSON("9007199254740992") } } };
  const [meta, , originalGraph] = await metaFromBytes(testPng(2, 2, undefined, wireGraph));
  assertEquals(originalGraph.node.inputs.max, 18446744073709551615n);
  assertEquals(typeof meta.nodes[0].inputs.max, "number");
  const rig = typedRunRig({ graph: originalGraph });
  const body = await rig.request({ "node.flag": { enabled: true, values: [true] }, "node.nullable": { enabled: true, values: [null] },
    "node.data": { enabled: true, values: [{ z: [false, null, 18446744073709551615n] }] },
    "node.array": { enabled: true, values: [{ __value__: ["save", 0] }] },
    "node.next": { enabled: true, values: [9007199254740993n] } });
  const result = await rig.run(body);
  assertEquals(result.status, 200); assertEquals(result.data.total, 1); assertEquals(rig.bytes.length, 1);
  const sent = values.parseExactJson(rig.bytes[0]);
  assertEquals(sent.prompt.node.inputs, { flag: true, nullable: null, data: { z: [false, null, 18446744073709551615n] },
    array: { __value__: ["save", 0] }, max: 18446744073709551615n, next: 9007199254740993n, untouched: 9007199254740993n, previous: 9007199254740992n });
  assertEquals(sent.prompt.save.inputs.filename_prefix, "manual_source_00001_");
  assert(shared.acknowledgedFields(body, result.data));
  const directory = Deno.env.get("KZ_TYPED_EVIDENCE");
  if (directory) { await Deno.mkdir(directory, { recursive: true }); await Deno.writeTextFile(`${directory}/actual-prompt.json`, rig.bytes[0]); }
});

Deno.test("typed Run: a later invalid known candidate prepares no enqueues, partial/uncertain never certify", async () => {
  const rig = typedRunRig({ graph, schema: { declarations: new Map([["Custom.flag", { type: "BOOLEAN" }]]) } });
  const result = await rig.run(await rig.request({ "node.flag": { enabled: true, values: [true, "false"] } }));
  assertEquals(result.status, 400); assertEquals(rig.bytes, []);
  for (const acceptance of ["partial", "uncertain"]) {
    const rig = typedRunRig({ graph, acceptance });
    const body = await rig.request({ "node.flag": { enabled: true, values: [true] } });
    const result = await rig.run(body);
    assertEquals(rig.bytes.length, 1); assertEquals(shared.acknowledgedFields(body, result.data), null);
  }
});

Deno.test("typed values: native numeric tokens round-trip without sentinel collisions", () => {
  const text = '{"safe":42,"max":18446744073709551615,"adjacent":[9007199254740992,9007199254740993],"raw":{"rawJSON":"123"}}';
  const parsed = values.parseExactJson(text);
  assertEquals(parsed.safe, 42); assertEquals(parsed.max, 18446744073709551615n);
  assertEquals(parsed.adjacent, [9007199254740992n, 9007199254740993n]);
  assertEquals(values.stringifyExactJson(parsed), text);
  assertThrows(() => values.stringifyExactJson({ rounded: Number.MAX_SAFE_INTEGER + 2 }), TypeError);
  assertThrows(() => values.cloneJsonValue(JSON.rawJSON("123")), TypeError);
  let reads = 0;
  assertThrows(() => values.stringifyExactJson({ get value() { reads++; return 1; } }), TypeError);
  assertEquals(reads, 0);
});

Deno.test("exact generation boundary: unsupported unsafe Number never narrows legacy metadata or silently enqueues", async () => {
  const [meta, , original] = await metaFromBytes(testPng(2, 2, undefined, { n: { class_type: "Custom", inputs: { value: 1e100 } } }));
  assertEquals(meta.nodes[0].inputs.value, 1e100);
  const rig = typedRunRig({ graph: original });
  const probe = await rig.probe();
  assert(probe.error.includes("cannot be represented exactly")); assertEquals(rig.bytes, []);
});

Deno.test("typed compiler: false, zero, text and null remain distinct; whole containers dedupe before the kernel", () => {
  const candidates = [false, 0, "0", null, [false, null], { x: [false, null] }, { x: [false, null] }, false, null, 0, "0"];
  const parameters = values.graphParameters({ n: { inputs: { value: false } } });
  const before = values.cloneJsonValue(candidates);
  const axes = compileDiscreteAxes({ "n.value": { enabled: true, values: candidates } }, parameters);
  const expected = [false, 0, "0", null, { __value__: [false, null] }, { x: [false, null] }];
  assertEquals(axes["n.value"].values, expected);
  assertEquals(candidates, before);
  const current = { "n.value": false };
  assertEquals(permutationPlan({}, current, { "n.value": { enabled: true, values: candidates } }).total, 9);
  assertEquals(permutationPlan({}, current, axes).total, 5);
  assertEquals(generatePermutations({}, current, axes).map(p => p["n.value"]), expected.slice(1));
  assert(values.sameJsonValue(1n, 1));
  assert(!values.sameJsonValue(9007199254740992n, 9007199254740993n));
  assertEquals(compileDiscreteAxes({ "n.value": { enabled: true, values: [1, 1n, 9007199254740992n, 9007199254740993n] } }, parameters)["n.value"].values,
    [1, 9007199254740992n, 9007199254740993n]);
});

Deno.test("typed axes: integer ranges preserve adjacent unsafe values and caps", () => {
  const ranges = { "n.seed": { enabled: true, min: 18446744073709551613n, max: 18446744073709551615n, increment: 1 } };
  assertEquals(generatePermutations(ranges, { "n.seed": 18446744073709551614n }), [
    { "n.seed": 18446744073709551613n }, { "n.seed": 18446744073709551615n },
  ]);
  assertThrows(() => permutationPlan({ "n.seed": { ...ranges["n.seed"], increment: .5 } }, {}), Error);
  assertEquals(generatePermutations({ "n.seed": { enabled: true, min: 9007199254740991, max: 9007199254740991, increment: 1 } }, {}), [{ "n.seed": 9007199254740991 }]);
});

Deno.test("typed integer count: current exclusion follows the generated rounded endpoint, not only nominal bounds", async () => {
  const ranges = { "n.seed": { enabled: true, min: 1, max: 4, increment: 2 } }, current = { "n.seed": 5 };
  const permutations = generatePermutations(ranges, current);
  assertEquals(permutations, [{ "n.seed": 1 }, { "n.seed": 3 }]);
  assertEquals(permutationPlan(ranges, current).total, permutations.length);
  const exact = { "n.seed": { enabled: true, min: 9007199254740993n, max: 9007199254740996n, increment: 2n } };
  const prior = { "n.seed": 9007199254740997n };
  assertEquals(permutationPlan(exact, prior).total, generatePermutations(exact, prior).length);
  const rig = typedRunRig({ graph: { n: { class_type: "Custom", inputs: { seed: 5 } },
    save: { class_type: "SaveImage", inputs: { filename_prefix: "source", images: ["n", 0] } } } });
  const body = await rig.request({}, ranges), result = await rig.run(body);
  assertEquals(result.status, 200); assertEquals(result.data.total, 2); assert(shared.acknowledgedFields(body, result.data));
  assertEquals(rig.bytes.map(text => values.parseExactJson(text).prompt.n.inputs.seed), [1, 3]);
});

Deno.test("typed naming: deterministic data tokens and actual surviving variations only", () => {
  assertEquals(formatValue(false), "false"); assertEquals(formatValue(null), "null");
  assertEquals(formatValue({ z: [null, false], a: 18446744073709551615n }), '{"a":18446744073709551615,"z":[null,false]}');
  const current = { "n.flag": false, "n.fixed": 0 };
  const axes = { "n.flag": { enabled: true, values: [false, true, true] }, "n.fixed": { enabled: true, values: [0] } };
  // Exclusion leaves only true/0. Neither value actually varies in submitted jobs.
  assertEquals(shared.automaticNaming({}, current, axes), { ids: [], suffix: "" });
  axes["n.flag"].values.push(null);
  assertEquals(shared.automaticNaming({}, current, axes), { ids: ["n.flag"], suffix: "_{n.flag}" });
});

Deno.test("automatic naming: raw repeated sequences use distinct surviving values, including equal endpoints", () => {
  const axes = { "n.value": { enabled: true, values: ["a", "b", "a"] } };
  assertEquals(shared.automaticNaming({}, { "n.value": "absent" }, axes), { ids: ["n.value"], suffix: "_{n.value}" });
  assertEquals(shared.automaticNaming({}, { "n.value": "b" }, axes), { ids: [], suffix: "" });
  assertEquals(shared.automaticNaming({}, { "n.value": "a" }, axes), { ids: [], suffix: "" });
  axes["n.fixed"] = { enabled: true, values: [false, false] };
  assertEquals(shared.automaticNaming({}, { "n.value": "a", "n.fixed": true }, axes), { ids: ["n.value"], suffix: "_{n.value}" });
  assertEquals(shared.automaticNaming({}, { "n.value": "a", "n.fixed": false }, axes), { ids: [], suffix: "" });
  axes["n.value"].values = [{ x: false }, { x: null }, { x: false }];
  assertEquals(shared.automaticNaming({}, { "n.value": {}, "n.fixed": false }, axes), { ids: ["n.value"], suffix: "_{n.value}" });
  const ranges = { "n.seed": { enabled: true, min: 0n, max: 9007199254740990n, increment: 1n } };
  assertEquals(shared.automaticNaming(ranges, {}), { ids: ["n.seed"], suffix: "_{n.seed}" });
});

Deno.test("typed schema: address cache retains typed options, constraints, ports and recorded dynamic group declarations", async () => {
  let calls = 0;
  const cache = new Map(), fetcher = () => {
    calls++;
    return Promise.resolve(new Response('{"Custom":{"input":{"required":{"flag":["BOOLEAN",{}],"mode":[[false,null,0],{}],"seed":["INT",{"max":18446744073709551615}],"group":["COMFY_DYNAMICGROUP_V3",{"max":2,"template":{"required":{"flag":["BOOLEAN",{}]}}}]}},"output":["IMAGE","STRING"],"output_name":["pixels","caption"],"output_is_list":[false,true]}}'));
  };
  const schema = await objectInfo("fixture:8188", cache, { fetcher });
  await objectInfo("fixture:8188", cache, { fetcher }); assertEquals(calls, 1);
  assertEquals(schema.declarations.get("Custom.mode").options, [false, null, 0]);
  assertEquals(schema.declarations.get("Custom.seed").max, 18446744073709551615n);
  assertEquals(schema.declarations.get("Custom.group.1.flag").type, "BOOLEAN");
  assertEquals(schema.outputs.get("Custom"), [{ type: "IMAGE", name: "pixels", isList: false }, { type: "STRING", name: "caption", isList: true }]);
  const catalogue = values.graphParameters({ n: { class_type: "Custom", inputs: { "group.1.flag": false, unknown: null } } }, schema);
  assertEquals(catalogue.map(p => p.schema.status), ["known", "unavailable"]);
});

Deno.test("typed automatic naming: additive activation preserves manual text and fixed values", async () => {
  const rig = typedRunRig({ graph });
  const body = await rig.request({ "node.nullable": { enabled: true, values: [false, null] }, "node.flag": { enabled: true, values: [true] } });
  body.automaticNaming = true; body.suffix = "_manual_{node.flag}";
  const result = await rig.run(body);
  assertEquals(result.status, 200); assertEquals(rig.bytes.length, 2);
  assertEquals(rig.bytes.map(text => values.parseExactJson(text).prompt.save.inputs.filename_prefix), [
    "manual_source_00001__manual_true_false", "manual_source_00001__manual_true_null",
  ]);
  assertEquals(body.suffix, "_manual_{node.flag}");
  assert(shared.acknowledgedFields(body, result.data));
});

Deno.test("typed compilation: equivalent raw array/wrapper candidates count once and current is excluded", () => {
  const parameters = values.graphParameters({ n: { inputs: { array: { __value__: [true, null] } } } });
  const axes = compileDiscreteAxes({ "n.array": { enabled: true, values: [[true, null], { __value__: [true, null] }, [false, null]] } }, parameters);
  const current = { "n.array": { __value__: [true, null] } };
  assertEquals(axes["n.array"].values, [{ __value__: [true, null] }, { __value__: [false, null] }]);
  assertEquals(permutationPlan({}, current, axes).total, 1);
  assertEquals(generatePermutations({}, current, axes), [{ "n.array": { __value__: [false, null] } }]);
  const accessor = []; Object.defineProperty(accessor, "0", { enumerable: true, get() { throw new Error("getter activated"); } });
  assertThrows(() => permutationPlan({}, {}, { "n.array": { enabled: true, values: accessor } }), TypeError);
  assertThrows(() => compileDiscreteAxes({ "n.array": { enabled: true, values: accessor } }, parameters), TypeError);
});

Deno.test("typed Run: compiler dedupes normalized semantic candidates before count, final naming and v2 writes", async () => {
  const rig = typedRunRig({ graph });
  const body = await rig.request({
    "node.flag": { enabled: true, values: [true, true] },
    "node.nullable": { enabled: true, values: [null, null] },
    "node.data": { enabled: true, values: [{ a: false, z: [null, 18446744073709551615n] }, { z: [null, 18446744073709551615n], a: false }] },
    "node.array": { enabled: true, values: [[true, null], { __value__: [true, null] }, [false, null], { __value__: [false, null] }] },
    "node.next": { enabled: true, values: [9007199254740993n, 9007199254740993n] },
  });
  body.prefix = "v_"; body.suffix = "_s"; body.automaticNaming = true;
  const before = values.cloneJsonValue(body), result = await rig.run(body);
  assertEquals(result.status, 200); assertEquals(result.data.total, 2); assertEquals(rig.bytes.length, 2);
  assert(shared.acknowledgedFields(body, result.data)); assertEquals(body, before);
  const evidence = Deno.env.get("KZ_TYPED_EVIDENCE");
  if (evidence) {
    await Deno.mkdir(`${evidence}/dedup`, { recursive: true });
    await Deno.writeTextFile(`${evidence}/dedup/request.json`, values.stringifyExactJson(body));
    await Deno.writeTextFile(`${evidence}/dedup/response.json`, values.stringifyExactJson(result.data));
  }
  for (const [index, flag] of [true, false].entries()) {
    const actual = values.parseExactJson(rig.bytes[index]);
    assertEquals(actual.prompt.node.inputs.flag, true); assertEquals(actual.prompt.node.inputs.nullable, null);
    assertEquals(actual.prompt.node.inputs.data, { a: false, z: [null, 18446744073709551615n] });
    assertEquals(actual.prompt.node.inputs.array, { __value__: [flag, null] });
    assertEquals(actual.prompt.node.inputs.next, 9007199254740993n);
    assertEquals(actual.prompt.save.inputs.filename_prefix, `v_source_00001__s_{"__value__":[${flag},null]}`);
    const directory = Deno.env.get("KZ_TYPED_EVIDENCE");
    if (directory) { await Deno.mkdir(`${directory}/dedup`, { recursive: true }); await Deno.writeTextFile(`${directory}/dedup/actual-prompt-${index + 1}.json`, rig.bytes[index]); }
  }
});
