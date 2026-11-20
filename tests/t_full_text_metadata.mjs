import { assert, assertEquals } from "jsr:@std/assert";
import { collectNodes, metaFromBytes, EXTRACTOR_VERSION } from "../src/extractor.mjs";
import { makeRouter } from "../src/routes.mjs";
import { compileFilter } from "../client/js/feed-filter-model.mjs";
import { mkStateRig } from "./helpers/rig.mjs";
import { testPng } from "./helpers/png.mjs";
import { fullTextPrompt, fullTextEnding, fullTextGraph } from "./helpers/full-text.mjs";

const textValue = meta => meta.nodes.find(node => node.id === "1").inputs.text;
const png = () => testPng(64, 48, undefined, fullTextGraph);

Deno.test("full text: 10,000 characters round-trip through generic and byte extraction exactly", async () => {
  assertEquals(fullTextPrompt.length, 10_000);
  assertEquals(collectNodes(fullTextGraph)[0].inputs.text, fullTextPrompt);
  const [meta, , graph] = await metaFromBytes(png(), "full-text.png");
  assertEquals(textValue(meta), fullTextPrompt);
  assertEquals(graph, fullTextGraph, "the original graph is independent of display metadata");
});

Deno.test("full text: stored metadata APIs retain the complete extracted parameter", async () => {
  const rig = await mkStateRig("full-text-api", { hosts: { local: "folder:/unused" } });
  const router = makeRouter({ ...rig, plugins: null, prefetch: { pending: () => 0, dimsPending: () => 0 } });
  const get = async path => {
    const response = await router.handle(new Request(`http://x/api/collections/local/${path}`));
    assertEquals(response.status, 200);
    return response.json();
  };
  try {
    await rig.ingest.ensureBytes("local", "full-text.png", png());
    const record = await get("entries/full-text.png/meta");
    assert(record.extracted);
    assertEquals(textValue(record.meta), fullTextPrompt);
    assertEquals(textValue((await get("meta")).items["full-text.png"]), fullTextPrompt);
  } finally { await rig.close(); }
});

Deno.test("full text: version 5 content re-extracts on next ingest, including content aliases", async () => {
  const rig = await mkStateRig("full-text-upgrade", { hosts: { local: "folder:/unused" } });
  try {
    const bytes = png(), hash = await rig.ingest.ensureBytes("local", "full-text.png", bytes);
    await rig.store.ingestFile("local", "alias.png", hash, bytes.length);
    await rig.store.metaPut("local", "full-text.png", {
      nodes: [{ id: "1", type: "CLIPTextEncode", inputs: { text: fullTextPrompt.slice(0, 4096) + "\u2026" } }],
    }, { ext: 5 });
    assertEquals(rig.store.contentGet(hash).ext, 5);
    const since = rig.store.metaVersion;
    await rig.ingest.ensureBytes("local", "full-text.png", bytes);
    assert(EXTRACTOR_VERSION > 5, "version 5 must be stale");
    assertEquals(rig.store.contentGet(hash).ext, EXTRACTOR_VERSION);
    for (const name of ["full-text.png", "alias.png"]) {
      assertEquals(textValue(rig.store.metaState("local", name).meta), fullTextPrompt);
      assertEquals(textValue(rig.store.metadataSince("local", since).items[name]), fullTextPrompt);
    }
  } finally { await rig.close(); }
});

Deno.test("full text: feed Contains finds text beyond 4,096 and Equals uses the complete value", async () => {
  const [meta] = await metaFromBytes(png(), "full-text.png");
  assert(fullTextPrompt.indexOf(fullTextEnding) > 4096);
  const condition = { parameter: "CLIPTextEncode.text", parameterMode: "contains", parameterValue: fullTextEnding };
  assertEquals(compileFilter(condition)({ meta }), true);
  assertEquals(compileFilter({ ...condition, parameterValue: "not in the prompt" })({ meta }), false);
  assertEquals(compileFilter({ ...condition, parameterMode: "equals", parameterValue: fullTextPrompt })({ meta }), true);
  assertEquals(compileFilter({ ...condition, parameterMode: "equals", parameterValue: fullTextPrompt.slice(0, 4096) })({ meta }), false);
});
