import { assert, assertEquals } from "jsr:@std/assert";
import { fieldList, fullFieldRows } from "../client-solid/store/fields.js";

Deno.test("deepscan B fields: metadata is indexed once per materialization without stale mutable caches", () => {
  let reads = 0;
  const count = 200, meta = { nodes: Array.from({ length: count }, (_, i) => ({ id: String(count - i), get type() { reads++; return "Type" + i; }, inputs: { value: i } })) };
  const list = fieldList(Object.fromEntries(Array.from({ length: count }, (_, i) => ["Type" + i, { inputs: { value: "number", absent: "string" } }])));
  const rows = fullFieldRows(meta, { list }); assertEquals(rows.length, count);
  assert(reads <= count * 3, `read ${reads} node types`);
  meta.nodes[0].inputs.value = 999;
  assert(fullFieldRows(meta, { list }).some(([label, value]) => label.startsWith("Type0 ") && value === "999"));
  const multi = { nodes: [{ id: "10", type: "T", inputs: { value: true } }, { id: "2", type: "T", inputs: { value: 2 } }] };
  assertEquals(fieldList({ T: { inputs: { value: "number" } } })[0][1](multi), [2, "true"]);
});
