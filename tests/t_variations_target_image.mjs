import { assert, assertEquals } from "jsr:@std/assert";
import { editorRig } from "./helpers/variation-editor.mjs";
import { makeVariationEditor } from "../client-solid/features/variations/editor.js";
import { catalogueParams, templateReplace } from "../src/features/variations/shared.mjs";

Deno.test("target image: each target compiles its own output identity, count, naming and ordered set", async () => {
  const rig = editorRig(), origin = rig.context.origin;
  const targets = ["first.png", "nested/second.png"].map(filename => ({ id: "fake:" + filename, host: "fake", filename, origin }));
  rig.catalogue.stringParams[0].kind = "image";
  const editor = makeVariationEditor({ targets, services: rig.services, currentOrigin: () => origin });
  editor.installCatalogue(rig.catalogue); editor.installInputs({ origin, files: ["next.png"] });
  editor.edit("numeric", "n.denoise", "enabled", false); editor.edit("images", "image.image", "enabled", true);
  editor.toggleTargetImage("image.image"); editor.addImages("image.image", [{kind:"input",name:"next.png"}]);
  assertEquals(editor.preview().perImage, 2); assertEquals(editor.preview().n, 4);
  assertEquals(editor.rows("images")["image.image"].images[0].name, "first.png");
  assert(editor.rows("images")["image.image"].images[0].each);
  const result = await editor.run(); assertEquals(result.submitted, 4); assert(result.adopted);
  assertEquals(rig.uploads.length, 0);
  for (const [index, request] of rig.requests.entries()) {
    assertEquals(request.imageParams["image.image"].values, [targets[index].filename + " [output]", "next.png"]);
    assertEquals(templateReplace("{image.image}", {"image.image":request.imageParams["image.image"].values[0]}, {}, {}, catalogueParams(rig.catalogue)), index ? "second" : "first");
  }
  editor.moveImage("image.image", {kind:"target"}, 1);
  assertEquals(editor.rows("images")["image.image"].items.map(item=>item.kind), ["input","target"]);
  editor.toggleTargetImage("image.image"); assertEquals(editor.rows("images")["image.image"].items, [{kind:"input",name:"next.png"}]);
  editor.dispose(); rig.editor.dispose();
});
