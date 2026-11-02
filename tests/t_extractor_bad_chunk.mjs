// tests/t_extractor_bad_chunk.mjs — the PNG chunk loop must terminate on a
// chunk that throws (garbage zlib) or is malformed (missing NUL separators),
// and still read the good chunks after it. And: PNG-sourced metas carry no
// queue index (a PNG has no history entry).

import { assert, assertEquals } from "jsr:@std/assert";
import { metaFromBytes, metaFromPngBytes, parsePngTextChunks, EXTRACTOR_VERSION } from "../src/extractor.mjs";
import { mkStateRig } from "./helpers/rig.mjs";

const SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

// length(4) + type(4) + payload + crc(4) — the parser never reads the crc
function chunk(type, payload) {
  const out = new Uint8Array(12 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

const text = (s) => new TextEncoder().encode(s);

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

const PROMPT = JSON.stringify({
  1: {
    class_type: "KSampler",
    inputs: { seed: 42, steps: 20, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 1 },
  },
});

Deno.test("extractor: garbage zTXt payload is skipped, the loop terminates", async () => {
  const png = concat(
    SIG,
    chunk("zTXt", concat(text("prompt"), new Uint8Array([0, 0]), text("definitely-not-zlib"))),
    chunk("tEXt", concat(text("prompt"), new Uint8Array([0]), text(PROMPT))),
    chunk("IDAT", new Uint8Array([1, 2, 3])),
  );
  const chunks = await parsePngTextChunks(png); // must return, not hang
  // the garbage chunk threw and was skipped; the good one after it was read
  assertEquals(JSON.parse(chunks.prompt).inputs === undefined, true); // it's the graph JSON
  assertEquals(JSON.parse(chunks.prompt)["1"].class_type, "KSampler");
});

Deno.test("extractor: malformed iTXt (no NUL terminators) is skipped", async () => {
  const png = concat(
    SIG,
    chunk("iTXt", text("no-terminators-anywhere")),
    chunk("tEXt", concat(text("note"), new Uint8Array([0]), text("alive"))),
    chunk("IDAT", new Uint8Array([9])),
  );
  const chunks = await parsePngTextChunks(png);
  assertEquals(chunks.note, "alive");
});

Deno.test("extractor: PNG metas carry no queue index", async () => {
  const png = concat(
    SIG,
    chunk("tEXt", concat(text("prompt"), new Uint8Array([0]), text(PROMPT))),
    chunk("IDAT", new Uint8Array([0])),
  );
  const [meta] = await metaFromPngBytes(png);
  assert(meta, "expected meta from the prompt chunk");
  assertEquals(meta.seed, 42);
  assertEquals("q" in meta, false);
});

// Incompressible text keeps even the compressed chunk payload above the old
// scan-start budget. That budget must never become a metadata payload limit.
const largeGraph = () => {
  let state = 42;
  const noise = Array.from({ length: 500_000 }, () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return String.fromCharCode(33 + ((state >>> 0) % 90));
  }).join("");
  return { ...JSON.parse(PROMPT), text: { class_type: "CLIPTextEncode", inputs: { text: noise } } };
};
async function metadataChunk(type, key, value, compressed = false) {
  let bytes = text(value);
  if (type === "zTXt" || compressed) bytes = new Uint8Array(await new Response(
    new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  const separators = type === "zTXt" ? [0, 0] : type === "iTXt" ? [0, +compressed, 0, 0, 0] : [0];
  const result = chunk(type, concat(text(key), new Uint8Array(separators), bytes));
  assert(result.length > 256 * 1024, "regression requires an oversized encoded payload");
  return result;
}

for (const [type, compressed] of [["tEXt", false], ["zTXt", true], ["iTXt", false], ["iTXt", true], ["comf", false]]) {
  Deno.test(`extractor: oversized ${type} (${compressed ? "compressed" : "plain"}) keeps prompt/workflow before and after IDAT`, async () => {
    const graph = largeGraph(), prompt = await metadataChunk(type, "prompt", JSON.stringify(graph), compressed);
    const workflow = await metadataChunk(type, "workflow", JSON.stringify({ nodes: graph }), compressed);
    assertEquals(JSON.parse((await parsePngTextChunks(concat(SIG, prompt))).prompt), graph,
      "the legacy scan-start budget permits the full first chunk");
    const png = concat(SIG, chunk("IDAT", new Uint8Array(300_000)), prompt, workflow, chunk("IEND", new Uint8Array()));
    const [meta, hasWorkflow, executed] = await metaFromBytes(png);
    assertEquals(executed, graph); assert(hasWorkflow); assertEquals(meta.seed, 42);
  });
}

Deno.test("extractor: stale ingested PNG retains oversized metadata through version upgrade", async () => {
  const graph = largeGraph(), png = concat(SIG,
    await metadataChunk("tEXt", "prompt", JSON.stringify(graph)),
    await metadataChunk("tEXt", "workflow", JSON.stringify({ nodes: graph })));
  const rig = await mkStateRig("large-png-upgrade", { hosts: { fake: "folder:/unused" } });
  try {
    const hash = await rig.ingest.ensureBytes("fake", "large.png", png);
    await rig.store.metaPut("fake", "large.png", { seed: 42 }, { hasWorkflow: true, ext: EXTRACTOR_VERSION - 1 });
    await rig.ingest.ensureBytes("fake", "large.png", png);
    const content = rig.store.contentGet(hash);
    assertEquals(content.ext, EXTRACTOR_VERSION);
    assertEquals(rig.store.metaState("fake", "large.png").meta.seed, 42);
    assertEquals(await rig.ingest.graph(hash), graph);
    assertEquals((await metaFromBytes(png))[1], true);
  } finally { await rig.close(); }
});
