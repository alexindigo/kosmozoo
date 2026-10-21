import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import * as shared from "../src/features/variations/shared.mjs";
import * as server from "../src/features/variations/server.mjs";
import { makeVariationEditor } from "../client-solid/features/variations/editor.js";

const graph = {
  "20": { class_type: "LoraLoader", inputs: { strength_model: .8, lora_name: "a" } },
  "21": { class_type: "LoraLoader", inputs: { strength_model: .5, lora_name: "b" }, _meta: { title: "Style" } },
  "76": { class_type: "LoadImage", inputs: { image: "content.png" } },
  "81": { class_type: "LoadImage", inputs: { image: "style.png [output]" } },
  "92:105": { class_type: "CLIPTextEncode", inputs: { text: "positive" }, _meta: { title: "Same" } },
  "92:106": { class_type: "CLIPTextEncode", inputs: { text: "negative" }, _meta: { title: "Same" } },
};
const enums = new Map([["LoraLoader.lora_name", ["a", "b", "c"]]]);
const descriptors = () => [...server.inspectGraph(graph), ...server.stringParams(graph),
  ...server.enumParams(graph, enums), ...server.textParams(graph, enums)];

Deno.test("identity: every kind has unique own-node axes, independent mutation and tokens", () => {
  const params = descriptors();
  assertEquals(params.length, 8);
  assertEquals(new Set(params.map(p => p.id)).size, 8);
  for (const p of params) {
    const nodeId = p.nodeIds[0];
    assertEquals(p.nodeIds.length, 1);
    assertEquals(p.id, shared.paramId(nodeId, p.key));
    assertEquals(shared.parseParamId(p.id), { nodeId, input: p.key });
    const value = typeof p.current === "number" ? .25 : `changed-${nodeId}`;
    const mutated = server.mutateGraph(graph, { [p.id]: value }, params);
    assertEquals(mutated.applied, [p.id]);
    assertEquals(mutated.writes, [{ id: p.id, nodeId, key: p.key, value }]);
    const expected = structuredClone(graph); expected[nodeId].inputs[p.key] = value;
    assertEquals(mutated.graph, expected);
    assertEquals(shared.templateReplaceWithProof(`_{${p.id}}`, { [p.id]: value }, {}),
      { text: `_${value}`, complete: true });
  }
});

Deno.test("identity: codec handles nested IDs and delimiter-bearing names without collisions", () => {
  for (const [nodeId, input] of [["92:105", "image"], ["node.with.dot", "input.name"], ["a{b}", "input space"]]) {
    const id = shared.paramId(nodeId, input);
    assertEquals(shared.parseParamId(id), { nodeId, input });
    assertEquals(shared.templateReplaceWithProof(`{${id}}`, { [id]: "own" }, {}), { text: "own", complete: true });
  }
  assert(shared.paramId("a.b", "c") !== shared.paramId("a", "b.c"));
  assertEquals(shared.parseParamId("not-an-id"), null);
  assertEquals(shared.templateReplaceWithProof("_{Old#92:105.image}", {}, {}).complete, false);
});

Deno.test("identity: two-image by two-LoRA permutations exclude exactly the current tuple", () => {
  const params = descriptors(), currents = Object.fromEntries(params.map(p => [p.id, p.current]));
  const ranges = Object.fromEntries(server.inspectGraph(graph).map(p => [p.id,
    { enabled: true, min: p.current, max: p.current + .1, increment: .1 }]));
  const images = Object.fromEntries(server.stringParams(graph).map(p => [p.id,
    { enabled: true, values: [p.current, `${p.nodeIds[0]}.png`] }]));
  assertEquals(shared.permutationPlan(ranges, currents, images).total, 15);
  assertEquals(shared.generatePermutations(ranges, currents, images).length, 15);
  delete ranges[shared.paramId("21", "strength_model")];
  for (const permutation of shared.generatePermutations(ranges, currents, images)) {
    assertEquals(server.mutateGraph(graph, permutation, params).graph["21"].inputs.strength_model, .5);
  }
});

Deno.test("identity: catalogue resolution and duplicate IDs fail before editor seeding or writes", () => {
  const params = descriptors(), p = params[0];
  assertThrows(() => shared.parameterIndex([p, p]), Error, "Duplicate");
  assertThrows(() => shared.parameterIndex([{ ...p, nodeIds: ["missing"] }], graph));
  assertThrows(() => server.mutateGraph(graph, { [p.id]: .2 }, [p, p]), Error, "Duplicate");
  const origin = { source: "fake", address: "fake:8188", kind: "comfy", epoch: "epoch", incarnation: "instance" };
  const editor = makeVariationEditor({ targets: [{ id: "fake:a.png", host: "fake", filename: "a.png", origin }],
    services: {}, currentOrigin: () => origin });
  assertThrows(() => editor.installCatalogue({ context: { origin, graphHash: "a".repeat(64) },
    params: [p, p], stringParams: [], enumParams: [], textParams: [] }), Error, "Duplicate");
  assertEquals(editor.rows("numeric"), {});
  assertEquals(editor.ready(), false);
  editor.dispose();
});

Deno.test("identity: legacy naming aliases always select the first carrier, including when only its sibling varies", () => {
  const params = descriptors(), values = Object.fromEntries(params.map(p => [p.id, p.current]));
  const aliases = shared.parameterAliases(params);
  assertEquals(shared.templateReplaceWithProof('{LoadImage.image}|{image}|{81.image}|{LoraLoader.strength_model}|{Same}',
    { '81.image': 'second.png', '21.strength_model': .2, '92:106.text': 'changed negative' }, values, aliases),
  { text: 'content.png|content.png|second.png|0.8|positive', complete: true });
  for (const token of ['{unknown#id.image}', '{unknown space}', '{}', '{{76.image}}', '{76.image', '76.image}']) {
    assertEquals(shared.templateReplaceWithProof(token, {}, {}).complete, false);
  }
});

Deno.test("identity: equal image values/titles never merge rows or their native Files", () => {
  const source = structuredClone(graph);
  source['76']._meta = source['81']._meta = { title: 'Reference' };
  source['76'].inputs.image = source['81'].inputs.image = 'same.png';
  const data = server.parameterCatalogue(source, { enums });
  const origin = { source: 'fake', address: 'fake:8188', kind: 'comfy', epoch: 'epoch', incarnation: 'instance' };
  data.context = { origin, graphHash: 'a'.repeat(64) };
  const editor = makeVariationEditor({ targets: [{ id: 'fake:a.png', host: 'fake', filename: 'a.png', origin }],
    services: {}, currentOrigin: () => origin });
  editor.installCatalogue(data);
  const first = new File(['a'], 'a.png'), second = new File(['b'], 'b.png');
  editor.edit('images', '76.image', 'localFiles', [first]);
  editor.edit('images', '81.image', 'localFiles', [second]);
  editor.installInputs({ origin, files: ['same.png'] });
  assertEquals(Object.keys(editor.rows('images')), ['76.image', '81.image']);
  assert(editor.rows('images')['76.image'].localFiles[0] === first);
  assert(editor.rows('images')['81.image'].localFiles[0] === second);
  assertEquals(editor.rows('images')['76.image'].label, 'Reference #76 · image');
  assertEquals(editor.rows('images')['81.image'].label, 'Reference #81 · image');
  assertThrows(() => editor.installCatalogue({ ...data, textParams: [...data.textParams, data.params[0]] }), Error, 'Duplicate');
  assert(editor.rows('images')['76.image'].localFiles[0] === first);
  editor.dispose();
});
