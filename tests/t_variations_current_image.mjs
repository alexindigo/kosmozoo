import { assert, assertEquals } from "jsr:@std/assert";
import { register } from "../src/features/variations/server.mjs";
import { makeCollectionLifecycle } from "../src/backings/index.mjs";
import { makeVariationEditor } from "../client-solid/features/variations/editor.js";
import { resourceReference } from "../src/parameters.mjs";

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
        const response = await routes.get("POST/run")(new Request("http://x/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) }));
        return { ok: response.ok, status: response.status, data: await response.json() };
      } } });
  editor.installCatalogue(catalogue);
  return { editor, catalogue, jobs, requests, inspections };
}

for (const current of ["same.png", "same.png [input]", "nested/a [b].png [input]", "same.png [output]", "nested/a [b].png [output]", "nested/a.png [temp]"]) {
  Deno.test(`recorded current default: ${current} is clean/off, ordinary, removable and retained`, async () => {
    const { editor, catalogue, inspections, jobs } = await rig(current);
    try {
      const id = "image.image", item = editor.rows("images")[id].items[0];
      assertEquals(item, { kind: "reference", value: current });
      assert(!editor.rows("images")[id].enabled); assert(!editor.dirty());
      editor.setEnabled(id, true); assertEquals(editor.preview().n, 0);
      await editor.run(); assertEquals(jobs, []);
      assertEquals(inspections, []); assertEquals(jobs, []);
      editor.removeImage(id, item); editor.setEnabled(id, false);
      editor.installCatalogue(catalogue); editor.setEnabled(id, true);
      assertEquals(editor.rows("images")[id].items, []); assert(editor.dirty());
    } finally { editor.dispose(); }
  });
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
      assertEquals(r.inspections, Array(2).fill({ name: r.catalogue.stringParams[0].current, kind: r.catalogue.stringParams[0].currentRoot }));
      assert(editor.rows("images")["image.image"].items[1].file === file);
    } finally { editor.dispose(); }
  });
}

for (const current of ["same.png [input]", "nested/a [b].png [input]"]) for (const kind of ["input", "reference"]) {
  Deno.test(`equivalent current reference: remove/reselect ${kind} retains exact ${current}`, async () => {
    const r = await rig(current), { editor } = r, id = "image.image", name = resourceReference(current).name;
    try {
      editor.setEnabled(id, true); assertEquals(editor.preview().n, 0);
      editor.removeImage(id, editor.rows("images")[id].items[0]);
      editor.addImages(id, [kind === "input" ? {kind,name} : {kind,value:name}]);
      assert(editor.rows("images")[id].images[0].sameCurrent);
      assertEquals(editor.preview().n, 0, "equivalent root/name must retain the original raw current tuple");
      await editor.run();assertEquals(r.jobs,[]);assertEquals(r.requests[0].imageParams[id].values,[current]);
      editor.setEnabled("n.denoise", true);editor.edit("numeric","n.denoise","mode","value");editor.edit("numeric","n.denoise","value","0.5");
      assertEquals(editor.preview().n,1);const result=await editor.run();assertEquals(result.adopted,true);assertEquals(result.submitted,1);
      assertEquals(r.requests.at(-1).imageParams[id].values,[current]);assertEquals(r.requests.at(-1).acknowledgement.version,2);
      assertEquals(r.jobs.map(job=>job.prompt.image.inputs.image),[current]);assertEquals(r.inspections,[]);assert(!editor.dirty());
      console.log(JSON.stringify({current,kind,currentOnlyJobs:0,request:r.requests.at(-1).imageParams[id].values,finalPrompt:r.jobs[0].prompt.image.inputs.image,version:2,adopted:result.adopted}));
    } finally {editor.dispose();}
  });
}

Deno.test("recorded reference: a changed numeric axis retains both current and alternative final assignments", async () => {
  const r = await rig("nested/same.png [temp]"), { editor } = r;
  try {
    editor.setEnabled("image.image", true); editor.addImages("image.image", [{kind:"input",name:"alternative.png"}]);
    editor.setEnabled("n.denoise", true);editor.edit("numeric","n.denoise","mode","value");editor.edit("numeric","n.denoise","value","0.5");
    assertEquals(editor.preview().n,2);assertEquals((await editor.run()).adopted,true);
    assertEquals(r.requests[0].imageParams["image.image"].values,["nested/same.png [temp]","alternative.png"]);
    assertEquals(r.jobs.map(job=>job.prompt.image.inputs.image),["nested/same.png [temp]","alternative.png"]);
    assertEquals(r.inspections,[]);assert(!editor.dirty());
  } finally {editor.dispose();}
});

for (const root of ["output","temp"]) Deno.test(`current image: a same-name input is distinct from the byte-identical ${root} current`, async () => {
  const current=`same.png [${root}]`, r = await rig(current), { editor } = r;
  try {
    editor.edit("numeric", "n.denoise", "enabled", false); editor.edit("images", "image.image", "enabled", true);
    editor.addImages("image.image", [{ kind: "input", name: "same.png" }, { kind: "upload", name: "copy.png", file: new File(["same"], "copy.png") }]);
    await editor.inspectImages();
    assertEquals(editor.rows("images")["image.image"].images.map(item => item.sameCurrent), [true, false, true]);
    assertEquals(editor.preview().n, 1, "exclude output current, not the distinct same-name input");
    const result = await editor.run(); assertEquals(result.adopted, true); assertEquals(result.submitted, 1);
    assertEquals(r.jobs.length, 1); assertEquals(r.jobs[0].prompt.image.inputs.image, "same.png");
    assertEquals(r.requests[0].imageParams["image.image"].values, [current, "same.png"]);
  } finally { editor.dispose(); }
});
