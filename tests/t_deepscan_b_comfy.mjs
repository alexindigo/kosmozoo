import { assert, assertEquals } from "jsr:@std/assert";
import { objectInfo, parseListingEntry, enqueue } from "../src/backings/comfy.mjs";

const schema = input => objectInfo("fixture.invalid", new Map(), { fetcher: () => Response.json(input) });
Deno.test("deepscan B schema: excessive dynamic nesting fails atomically with unavailable maps", async () => {
  let input = { required: { number: ["FLOAT", { default: .5 }] } };
  for (let i = 0; i < 40; i++) input = { required: { mode: ["COMFY_DYNAMICCOMBO_V3", { options: [{ key: "on", inputs: input }] }] } };
  const result = await schema({ Normal: { output_node: true, input: { required: { seed: ["INT", {}] } } }, Deep: { input } });
  for (const key of ["types", "enums", "dynamicCombos", "outputClasses", "lazyInputs"]) assert(result[key] === null, `${key} must remain unavailable`);
});

Deno.test("deepscan B schema: expanded entries share one aggregate budget across classes", async () => {
  const required = Object.fromEntries(Array.from({ length: 26_000 }, (_, i) => ["n" + i, ["INT", { default: i }]]));
  const result = await schema(Object.fromEntries(["A", "B", "C"].map(type => [type, { input: { required } }])));
  assert(result.types === null); assert(result.enums === null);
});

Deno.test("deepscan B listing: annotation failure is linear and normal identities stay exact", () => {
  const input = "image.png" + " ".repeat(100_000) + "[unfinished";
  const start = performance.now(); assertEquals(parseListingEntry(input), { name: input, size: null });
  assert(performance.now() - start < 1000);
  for (const [value, name, size] of [["a [b].png [7]", "a [b].png", 7], ["a.png  [output]", "a.png ", null], ["a [b[c]", "a", null], ["a.png", "a.png", null]]) {
    assertEquals(parseListingEntry(value), { name, size });
  }
});

Deno.test("deepscan B enqueue: upstream error bodies and failures remain one escaped log record", async () => {
  const body = 'bad\n[engine] forged\r\x1b[31m\u0085\u2028detail';
  const logs = [], native = console.error; console.error = (...args) => logs.push(args.join(" "));
  try {
    const result = await enqueue("fixture.invalid", { prompt: {} }, { fetcher: () => new Response(body, { status: 400 }) });
    assertEquals(result.status, 400); assert(result.error.includes(body));
    await enqueue("fixture.invalid", { prompt: {} }, { fetcher: () => { throw new Error(body); } });
    assertEquals(logs.length, 2);
    for (const log of logs) { assert(!/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(log), log); assert(log.includes("\\n")); }
  } finally { console.error = native; }
});

Deno.test("deepscan B listing: linear parser agrees with the annotation grammar on bounded inputs", () => {
  let state = 42;
  const alphabet = "ab []\t\n\r\u2028";
  for (let i = 0; i < 10_000; i++) {
    let value = "";
    for (let j = 0; j < 20; j++) { state = (state * 1664525 + 1013904223) >>> 0; value += alphabet[state % alphabet.length]; }
    const match = /^(.*)\s+\[([^\]]*)\]$/.exec(value);
    const expected = match ? { name: match[1], size: /^\d+$/.test(match[2]) ? Number(match[2]) : null } : { name: value, size: null };
    assertEquals(parseListingEntry(value), expected, JSON.stringify(value));
  }
});
