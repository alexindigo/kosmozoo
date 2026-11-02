import { assert, assertEquals } from "jsr:@std/assert";
import { register } from "../src/features/variations/server.mjs";
import { makeCollectionLifecycle } from "../src/backings/index.mjs";
import { makeVariationEditor } from "../client-solid/features/variations/editor.js";

// Real probe -> editor comparison/compile -> Run -> final enqueued prompt.
async function rig(current) {
  const graph = {
    image: { class_type: "LoadImage", inputs: { image: current } },
    n: { class_type: "Sampler", inputs: { denoise: 1, image: ["image", 0] } },
    out: { class_type: "SaveImage", inputs: { filename_prefix: "source", images: ["n", 0] } },
  };
  const hosts = { fake: "fake:8188" }, lifecycle = makeCollectionLifecycle(hosts), routes = new Map(), jobs = [], requests = [], inspections = [];
  const backing = { objectInfo: async () => ({ types: new Map([["Sampler.denoise", "FLOAT"]]), enums: new Map(), outputClasses: new Set(["SaveImage"]) }),
    enqueue: async job => { jobs.push(job); return { ok: true, status: 200, acceptance: "confirmed", promptId: `job-${jobs.length}`, nodeErrors: {} }; } };
  register({ hosts, store: { hashFor: () => "a".repeat(64) }, ingest: { graph: async () => structuredClone(graph) },
    backings: { capture: lifecycle.capture, isCurrent: lifecycle.isCurrent, comfy: () => backing, accepting: () => true,
      source: id => { const token = lifecycle.capture(id); return { address: token.address, kind: "comfy", incarnation: token.incarnation,
        sourceVersion: { epoch: "test", incarnation: token.incarnation } }; } },
    route: (method, path, handler) => routes.set(method + path, handler) });
  const id = "fake:source.png", response = await routes.get("GET/probe/<id>")(new Request("http://x/probe/" + encodeURIComponent(id)), { id });
  assertEquals(response.status, 200);
  const catalogue = await response.json(), origin = catalogue.context.origin;
  const inspect = async (_host, _resource, name, kind, expected) => {
    inspections.push({ name, kind }); return { hash: "a".repeat(64), currentHash: "a".repeat(64), origin: expected };
  };
  const editor = makeVariationEditor({ targets: [{ id, host: "fake", filename: "source.png", origin }], currentOrigin: () => origin,
    setTimer: () => 0, clearTimer() {}, services: { inspectImage: inspect, inspectPath: inspect,
      uploadInput: () => { throw new Error("same-current bytes must not upload"); }, uploadPath: () => { throw new Error("same-current path must not upload"); },
      run: async request => {
        requests.push(request);
        const response = await routes.get("POST/run")(new Request("http://x/run", { method: "POST", body: JSON.stringify(request) }));
        return { ok: response.ok, status: response.status, data: await response.json() };
      } } });
  editor.installCatalogue(catalogue);
  return { editor, catalogue, jobs, requests, inspections };
}

for (const current of ["same.png", "same.png [output]", "nested/a [b].png [output]"]) {
  Deno.test(`current image: ${current} keeps its exact graph value, count and exclusion across File/path acquisitions`, async () => {
    const r = await rig(current), { editor } = r;
    try {
      editor.edit("numeric", "n.denoise", "enabled", false); editor.edit("images", "image.image", "enabled", true);
      const file = new File(["same bytes"], "copy.png");
      editor.addImages("image.image", [{ kind: "upload", name: file.name, file }, { kind: "server-path", name: "copy.png", path: "/images/copy.png" }]);
      await editor.inspectImages();
      assert(editor.rows("images")["image.image"].images.every(item => item.sameCurrent));
      assertEquals(editor.preview().n, 0, "only the unchanged image tuple is excluded");
      editor.edit("numeric", "n.denoise", "enabled", true); editor.edit("numeric", "n.denoise", "mode", "value"); editor.edit("numeric", "n.denoise", "value", "0.5");
      assertEquals(editor.preview().n, 1);
      const result = await editor.run();
      assertEquals(result.adopted, true); assertEquals(result.submitted, 1); assert(!editor.dirty());
      assertEquals(r.jobs.length, 1); assertEquals(r.jobs[0].prompt.image.inputs.image, current);
      assertEquals(r.requests[0].imageParams["image.image"].values, [current]);
      assertEquals(r.inspections, Array(2).fill({ name: r.catalogue.stringParams[0].current, kind: current.endsWith("[output]") ? "output" : "input" }));
      assert(editor.rows("images")["image.image"].items[0].file === file);
    } finally { editor.dispose(); }
  });
}

Deno.test("current image: a same-name input is distinct from the byte-identical output current", async () => {
  const r = await rig("same.png [output]"), { editor } = r;
  try {
    editor.edit("numeric", "n.denoise", "enabled", false); editor.edit("images", "image.image", "enabled", true);
    editor.addImages("image.image", [{ kind: "input", name: "same.png" }, { kind: "upload", name: "copy.png", file: new File(["same"], "copy.png") }]);
    await editor.inspectImages();
    assertEquals(editor.rows("images")["image.image"].images.map(item => item.sameCurrent), [false, true]);
    assertEquals(editor.preview().n, 1, "exclude output current, not the distinct same-name input");
    const result = await editor.run(); assertEquals(result.adopted, true); assertEquals(result.submitted, 1);
    assertEquals(r.jobs.length, 1); assertEquals(r.jobs[0].prompt.image.inputs.image, "same.png");
    assertEquals(r.requests[0].imageParams["image.image"].values, ["same.png", "same.png [output]"]);
  } finally { editor.dispose(); }
});
