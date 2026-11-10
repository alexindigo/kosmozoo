import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import { parameterCatalogue } from "../src/features/variations/server.mjs";
import * as parameters from "../src/parameters.mjs";
import * as variations from "../src/features/variations/shared.mjs";
import { dependencyClosure, linkInputs, validateGraphLinks } from "../src/graph.mjs";
import { serveStatic } from "../src/static.mjs";

Deno.test("parameters: complete recorded inventory survives unavailable custom schema", () => {
  const graph = {
    "group:node.with.dot": { class_type: "Custom", _meta: { title: "Same" }, inputs: {
      "group.0.flag": false, nullable: null, array: [true, 0, "0"],
      object: { nested: [null, false] }, edge: ["other", 0],
      wrapped: { __value__: ["other", 0] }, count: 0, text: "",
    } },
    other: { class_type: "Custom", _meta: { title: "Same" }, inputs: { nullable: null } },
    save: { class_type: "SaveImage", inputs: { filename_prefix: "mine" } },
    load: { class_type: "LoadImage", inputs: { image: "custom.resource" } },
    untyped: { inputs: { recorded: true } },
  };
  const data = parameterCatalogue(graph, { outputClasses: new Set(["SaveImage"]) });
  assert(Array.isArray(data.parameters), "probe must expose a complete parameters sequence");
  assertEquals(data.parameters.map(p => [p.nodeId, p.key, p.valueKind, p.currentValue]), [
    ["group:node.with.dot", "group.0.flag", "boolean", false],
    ["group:node.with.dot", "nullable", "null", null],
    ["group:node.with.dot", "array", "array", [true, 0, "0"]],
    ["group:node.with.dot", "object", "object", { nested: [null, false] }],
    ["group:node.with.dot", "edge", "connection", ["other", 0]],
    ["group:node.with.dot", "wrapped", "object", { __value__: ["other", 0] }],
    ["group:node.with.dot", "count", "number", 0],
    ["group:node.with.dot", "text", "string", ""],
    ["other", "nullable", "null", null],
    ["save", "filename_prefix", "string", "mine"],
    ["load", "image", "string", "custom.resource"],
    ["untyped", "recorded", "boolean", true],
  ]);
  assertEquals(new Set(data.parameters.map(p => p.id)).size, 12);
  assert(data.parameters.every(p => p.schema.status === "unavailable"));
  assertEquals(data.params.map(p => p.id), ["group:node%2Ewith%2Edot.count"]);
  assertEquals(data.textParams.map(p => p.id), ["group:node%2Ewith%2Edot.text"]);
  assertEquals(data.stringParams, []);
});

Deno.test("parameters: exact descriptor, source isolation and own null presence", () => {
  const inputs = Object.assign(Object.create({ missing: "inherited" }), { value: { nested: [null, false, 0, "0"] } });
  const graph = { "a:b.c": { class_type: "Custom", inputs } };
  const [p] = parameters.graphParameters(graph);
  assertEquals(p, {
    id: "a:b%2Ec.value", nodeId: "a:b.c", nodeIds: ["a:b.c"], key: "value", type: "Custom", title: null,
    kind: "object", current: { nested: [null, false, 0, "0"] }, currentValue: { nested: [null, false, 0, "0"] },
    valueKind: "object", encoding: "json", schema: { status: "unavailable" },
    contract: { knowledge: "unknown", role: "unknown", type: null, literal: null, link: null, choices: null, resource: null,
      constraints: {}, section: null, lazy: false, display: {} }, legacyEditable: false,
  });
  p.currentValue.nested.push("snapshot only");
  assertEquals(inputs.value.nested, [null, false, 0, "0"]);
  const current = parameters.parameterCurrent;
  for (const v of [null, false, 0, ""]) assertEquals(current({ currentValue: v, current: "fallback" }), v);
  assertEquals(current(Object.assign(Object.create({ currentValue: "inherited" }), { current: "own" })), "own");
});

Deno.test("parameters: identity/name ports are the same owner and aliases retain first carriers", () => {
  for (const key of ["paramId", "parseParamId", "parameterIndex", "parameterLabel", "parameterAliases", "parameterCurrent"]) {
    assert(variations[key] === parameters[key], `${key} must delegate to the neutral owner`);
  }
  const ps = parameters.graphParameters({
    "node.with.dot": { class_type: "LoadImage", _meta: { title: "Same" }, inputs: { image: "folder/a.png [output]" } },
    "92:105": { class_type: "LoadImage", _meta: { title: "Same" }, inputs: { image: "folder/a.png [input]" } },
    "__proto__": { class_type: "Unused", inputs: {} },
  });
  assertEquals(ps.map(p => p.id), ["node%2Ewith%2Edot.image", "92:105.image"]);
  assertEquals(parameters.parameterAliases(ps), {
    "node%2Ewith%2Edot.image": ["LoadImage.image", "Same", "image"],
    "92:105.image": ["LoadImage.image", "Same"],
  });
  const aliases = parameters.parameterAliases(ps);
  assertEquals(variations.templateReplace("{image}|{Same}|{LoadImage.image}|{92:105.image}",
    { "92:105.image": "later.png" }, Object.fromEntries(ps.map(p => [p.id, parameters.parameterCurrent(p)])), aliases),
  "folder/a.png [output]|folder/a.png [output]|folder/a.png [output]|later.png");
  const protoGraph = JSON.parse('{"__proto__":{"class_type":"Custom","inputs":{"constructor":null,"group.0.flag":false}}}');
  const own = parameters.graphParameters(protoGraph);
  assertEquals(own.map(p => parameters.parseParamId(p.id)), [
    { nodeId: "__proto__", input: "constructor" }, { nodeId: "__proto__", input: "group.0.flag" },
  ]);
  assertEquals(parameters.parameterIndex(own, protoGraph).size, 2);
});

Deno.test("parameters: schema is partial evidence, never discovery or default materialization", () => {
  const schema = { types: new Map([["Custom.count", "FLOAT"], ["Custom.missing", "INT"]]),
    enums: new Map([["Custom.mode", ["a", "b"]]]) };
  const graph = { n: { class_type: "Custom", inputs: { count: 1, mode: "a", flag: true } } };
  const data = parameterCatalogue(graph, schema);
  assertEquals(data.parameters.map(p => p.schema), [
    { status: "partial", numericType: "FLOAT" }, { status: "partial", options: ["a", "b"] }, { status: "unavailable" },
  ]);
  assertEquals(data.params, [{ id: "n.count", nodeId: "n", nodeIds: ["n"], key: "count", type: "Custom", title: null, kind: "numeric", current: 1, integer: false }]);
  assertEquals(data.enumParams[0].values, ["a", "b"]);
  data.parameters[1].schema.options.push("snapshot only");
  assertEquals(schema.enums.get("Custom.mode"), ["a", "b"]);
  assertEquals(Object.keys(graph.n.inputs), ["count", "mode", "flag"]);
});

Deno.test("parameters: link provenance retains old graph semantics, wrappers and unresolved arrays", () => {
  const graph = {
    n: { class_type: "Custom", inputs: {
      edge: ["source", 0], numericId: [1, 0], dangling: ["missing", 0],
      negative: ["source", -1], fractional: ["source", .5], empty: [], data: [true, 2],
      wrapper: { __value__: ["missing", 0] }, curve: { __type__: "CURVE", __value__: { points: [] } },
      ordinary: { __value__: "untouched" },
    } }, source: { class_type: "Source", inputs: {} }, "1": { class_type: "Source", inputs: {} },
  };
  const ps = parameters.graphParameters(graph).filter(p => p.nodeId === "n");
  assertEquals(ps.map(p => [p.key, p.valueKind, p.encoding]), [
    ["edge", "connection", "kosmozoo-link"], ["numericId", "connection", "kosmozoo-link"],
    ["dangling", "connection", "kosmozoo-link"], ["negative", "array", "unresolved-array"],
    ["fractional", "array", "unresolved-array"], ["empty", "array", "unresolved-array"], ["data", "array", "unresolved-array"],
    ["wrapper", "object", "comfy-array-wrapper"], ["curve", "object", "comfy-curve-wrapper"], ["ordinary", "object", "json"],
  ]);
  assertEquals(linkInputs(graph.n), [["edge", ["source", 0]], ["numericId", [1, 0]], ["dangling", ["missing", 0]]]);
  assertEquals([...dependencyClosure(graph, "n")].sort(), ["1", "missing", "n", "source"]);
  assertThrows(() => validateGraphLinks(graph), Error, "missing node missing");
});

Deno.test("parameters: JSON clone/equality preserve types, containers, keys and array order", () => {
  const { cloneJsonValue: clone, sameJsonValue: same } = parameters;
  const source = JSON.parse('{"__proto__":{"safe":true},"nested":[false,0,"0",null,[],{}]}');
  const copied = clone(source);
  assertEquals(copied, source);
  assert(copied !== source && copied.nested !== source.nested && Object.hasOwn(copied, "__proto__"));
  assert(same(source, copied));
  assert(same({ a: 1, b: { x: false } }, { b: { x: false }, a: 1 }));
  for (const [a, b] of [[false, 0], [0, "0"], [false, null], [[], {}], [[1, 2], [2, 1]], [{}, { x: null }]]) assert(!same(a, b));
  copied.nested.push("copy");
  assertEquals(source.nested.length, 6);
});

Deno.test("parameters: JSON boundary rejects native Files and non-data without invoking getters", () => {
  const cyclic = {}; cyclic.self = cyclic;
  let reads = 0;
  const getter = { get x() { reads++; return 1; } };
  for (const value of [new File(["opaque"], "a.png"), new Date(), new Map(), undefined, NaN, Infinity,
    () => 1, cyclic, getter, Array(1), Object.defineProperty({}, "x", { value: 1 }), { [Symbol()]: 1 }]) {
    assertThrows(() => parameters.cloneJsonValue(value), TypeError);
    assertThrows(() => parameters.sameJsonValue(value, value), TypeError);
  }
  assertEquals(reads, 0);
});

Deno.test("parameters: browser delivery exposes the pure module and transitive graph owner only", async () => {
  for (const name of ["parameters.mjs", "graph.mjs", "features/variations/shared.mjs"]) {
    const response = await serveStatic(`/shared/${name}`);
    assertEquals(response.status, 200);
    assert(response.headers.get("content-type").includes("javascript"));
    assert((await response.text()).length > 0);
  }
  const denied = await serveStatic("/shared/features/variations/server.mjs");
  assertEquals(denied.status, 404);
  await denied.text();
});
