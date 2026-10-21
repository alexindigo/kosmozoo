import { assert, assertEquals } from "jsr:@std/assert";
import { editorRig } from "./helpers/variation-editor.mjs";

const activate = editor => {
  editor.edit("images", "image.image", "enabled", true);
  editor.edit("enums", "choice.value", "enabled", true);
  editor.edit("texts", "text.text", "enabled", true);
};
const deactivate = editor => {
  editor.edit("numeric", "n.denoise", "enabled", false);
  for (const [domain, id] of [["images", "image.image"], ["enums", "choice.value"], ["texts", "text.text"]]) editor.edit(domain, id, "enabled", false);
  editor.edit("texts", "submit.text", "enabled", true);
  editor.edit("texts", "submit.text", "text", "submitted");
};
Deno.test("selection ack: submitted off choices become clean across every row domain", async () => {
  const { editor } = editorRig(); activate(editor); await editor.run(); assert(!editor.dirty());
  deactivate(editor); assertEquals((await editor.run()).status, "submitted");
  assert(!editor.dirty()); assertEquals(editor.rows("numeric")["n.denoise"].enabled, false); editor.dispose();
});
Deno.test("selection ack: acknowledging off never acknowledges unused values or native Files", async () => {
  const { editor } = editorRig(), file = new File(["kept"], "kept.png");
  activate(editor); await editor.run(); deactivate(editor);
  editor.edit("numeric", "n.denoise", "rawIncrement", "1e");
  editor.edit("images", "image.image", "mode", "files"); editor.edit("images", "image.image", "file", "unused.png"); editor.edit("images", "image.image", "localFiles", [file]);
  editor.edit("enums", "choice.value", "picks", ["second"]); editor.edit("enums", "choice.value", "filter", "retained filter");
  editor.edit("texts", "text.text", "text", "unused edit"); editor.template("text.text", "dormant", "kept");
  assertEquals((await editor.run()).status, "submitted");
  assertEquals(editor.rows("numeric")["n.denoise"].enabled, false);
  assert(editor.rows("images")["image.image"].localFiles[0] === file);
  assert(editor.dirty()); assert(!editor.remaining().some(item => item.field === "enabled")); editor.dispose();
});
