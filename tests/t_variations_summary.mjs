import { assert, assertEquals } from "jsr:@std/assert";
import { editorRig } from "./helpers/variation-editor.mjs";

Deno.test("summary: the shared tuple kernel explains every factor and excludes only the unchanged tuple", () => {
  const { editor } = editorRig();
  try {
    editor.range("n.denoise", { min: .85, max: 1 });
    editor.edit("images", "image.image", "enabled", true);
    editor.addImages("image.image", ["origin.png", "next.png", "third.png"].map(name => ({ kind: "input", name })));
    const summary = editor.preview();
    assertEquals(summary.n, 11); assert(summary.exact);
    assertEquals(summary.axes.map(axis => [axis.id, axis.count]), [["n.denoise", 4], ["image.image", 3]]);
    assertEquals(summary.excluded, 1); assert(summary.breakdown.includes("3 input images"));
    assert(summary.breakdown.includes("4 denoise values"));
    assert(summary.breakdown.includes("1 unchanged combination excluded"));
    assert(summary.naming.example.includes("0.85")); assert(!summary.naming.example.includes("{n.denoise}"));
  } finally { editor.dispose(); }
});

Deno.test("summary: invalid raw Step and reversed bounds remain editable without a default-backed valid total", () => {
  const { editor } = editorRig();
  try {
    editor.edit("numeric", "n.denoise", "rawIncrement", "1e");
    let summary = editor.preview();
    assertEquals(summary.status, "invalid"); assertEquals(summary.n, null); assertEquals(summary.exact, false);
    assert(summary.message.includes("Step")); assertEquals(editor.rows("numeric")["n.denoise"].rawIncrement, "1e");
    editor.edit("numeric", "n.denoise", "rawIncrement", ".05");
    editor.range("n.denoise", { min: 1, max: .5 });
    summary = editor.preview(); assertEquals(summary.status, "invalid"); assertEquals(summary.n, null);
  } finally { editor.dispose(); }
});

Deno.test("summary: empty enabled choices and unresolved naming give specific reasons, not authoritative counts", () => {
  const { editor } = editorRig();
  try {
    editor.edit("enums", "choice.value", "enabled", true); editor.edit("enums", "choice.value", "picks", []);
    assertEquals(editor.preview().status, "invalid"); assert(editor.preview().message.includes("choose at least one"));
    editor.edit("enums", "choice.value", "enabled", false); editor.edit("naming", "root", "suffix", "_{missing}");
    assertEquals(editor.preview().naming.complete, false); assertEquals(editor.preview().status, "invalid");
  } finally { editor.dispose(); }
});

Deno.test("summary: pending image evidence is checking; unsafe numeric products are explicitly estimated", async () => {
  let release;
  const rig = editorRig({ inspectImage: (_host, _file, _current, _kind, origin) => new Promise(resolve => {
    release = () => resolve({ hash: "b".repeat(64), currentHash: "a".repeat(64), origin });
  }) });
  const { editor } = rig;
  try {
    editor.edit("images", "image.image", "enabled", true);
    editor.addImages("image.image", [{ kind: "upload", name: "file.png", file: new File(["bytes"], "file.png") }]);
    assertEquals(editor.preview().status, "checking"); assertEquals(editor.preview().exact, false);
    release(); await editor.inspectImages(); assertEquals(editor.preview().status, "ready");
    editor.edit("images", "image.image", "enabled", false);
    for (const id of ["n.denoise", "n.steps"]) {
      editor.edit("numeric", id, "enabled", true); editor.range(id, { min: 0, max: 1e9 });
      editor.edit("numeric", id, "rawIncrement", "1");
    }
    const summary = editor.preview(); assertEquals(summary.exact, false);
    assert(summary.message.includes("precision")); assert(summary.display.length < 16);
    assert(summary.fullCount.length > summary.display.length);
  } finally { editor.dispose(); }
});
