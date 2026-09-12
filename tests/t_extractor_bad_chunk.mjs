// tests/t_extractor_bad_chunk.mjs — the PNG chunk loop must terminate on a
// chunk that throws (garbage zlib) or is malformed (missing NUL separators),
// and still read the good chunks after it. And: PNG-sourced metas carry no
// queue index (a PNG has no history entry).

import { assert, assertEquals } from "jsr:@std/assert";
import { metaFromPngBytes, parsePngTextChunks } from "../src/extractor.mjs";

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
