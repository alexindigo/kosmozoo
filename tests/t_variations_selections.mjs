import { assert, assertEquals } from "jsr:@std/assert";
import { editorRig } from "./helpers/variation-editor.mjs";

const activate = editor => {
  editor.edit("images", "LoadImage.image", "enabled", true);
  editor.edit("enums", "Choice#choice.value", "enabled", true);
  editor.edit("texts", "Text#text.text", "enabled", true);
};
const deactivate = editor => {
  editor.edit("numeric", "BasicScheduler.denoise", "enabled", false);
  for (const [domain, id] of [["images", "LoadImage.image"], ["enums", "Choice#choice.value"], ["texts", "Text#text.text"]]) editor.edit(domain, id, "enabled", false);
  editor.edit("texts", "Text#submit.text", "enabled", true);
  editor.edit("texts", "Text#submit.text", "text", "submitted");
};
Deno.test("selection ack: submitted off choices become clean across every row domain", async () => {
  const { editor } = editorRig(); activate(editor); await editor.run(); assert(!editor.dirty());
  deactivate(editor); assertEquals((await editor.run()).status, "submitted");
  assert(!editor.dirty()); assertEquals(editor.rows("numeric")["BasicScheduler.denoise"].enabled, false); editor.dispose();
});
Deno.test("selection ack: acknowledging off never acknowledges unused values or native Files", async () => {
  const { editor } = editorRig(), file = new File(["kept"], "kept.png");
  activate(editor); await editor.run(); deactivate(editor);
  editor.edit("numeric", "BasicScheduler.denoise", "rawIncrement", "1e");
  editor.edit("images", "LoadImage.image", "mode", "files"); editor.edit("images", "LoadImage.image", "file", "unused.png"); editor.edit("images", "LoadImage.image", "localFiles", [file]);
  editor.edit("enums", "Choice#choice.value", "picks", ["second"]); editor.edit("enums", "Choice#choice.value", "filter", "retained filter");
  editor.edit("texts", "Text#text.text", "text", "unused edit"); editor.template("Text#text.text", "dormant", "kept");
  assertEquals((await editor.run()).status, "submitted");
  assertEquals(editor.rows("numeric")["BasicScheduler.denoise"].enabled, false);
  assert(editor.rows("images")["LoadImage.image"].localFiles[0] === file);
  assert(editor.dirty()); assert(!editor.remaining().some(item => item.field === "enabled")); editor.dispose();
});
