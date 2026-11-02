import { assert, assertEquals } from "jsr:@std/assert";
import { editorRig } from "./helpers/variation-editor.mjs";

for (const [field, label] of [["min", "From"], ["max", "To"], ["value", "Value"]]) {
  for (const raw of ["", "-", "abc", "1e"]) Deno.test(`numeric text: ${label} ${JSON.stringify(raw)} is retained and rejects before effects`, async () => {
    const { editor, requests, uploads } = editorRig();
    try {
      if (field === "value") editor.edit("numeric", "n.denoise", "mode", "value");
      editor.edit("numeric", "n.denoise", field, "0.9");
      editor.edit("numeric", "n.denoise", field, raw);
      assertEquals(editor.rows("numeric")["n.denoise"][field], raw);
      const preview = editor.preview();
      assertEquals(preview.status, "invalid"); assertEquals(preview.n, null); assertEquals(preview.axes, []);
      assert(preview.message.includes(label));
      assertEquals((await editor.run()).status, "invalid");
      assert(editor.result().text.includes(label));
      assertEquals(requests, []); assertEquals(uploads, []);
      // A valid edit restores the plan without losing the exact raw spelling.
      editor.edit("numeric", "n.denoise", field, " 9e-1 ");
      if (field === "max") editor.edit("numeric", "n.denoise", "min", "0.85");
      assertEquals(editor.preview().status, "ready");
      assertEquals((await editor.run()).adopted, true);
      assertEquals(requests.length, 1);
      const range = requests[0].ranges["n.denoise"];
      assertEquals(range[field === "max" ? "max" : "min"], .9);
      if (field === "value") assertEquals(range.max, .9);
      assertEquals(editor.rows("numeric")["n.denoise"][field], " 9e-1 ");
    } finally { editor.dispose(); }
  });
}
