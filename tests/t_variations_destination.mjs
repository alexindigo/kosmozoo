import { assert, assertEquals } from "jsr:@std/assert";
import { buildContext } from "../src/context.mjs";
import { testPng } from "./helpers/png.mjs";
import { makeVariationRecipe } from "../client-solid/features/variations/recipe.js";
import { numericDefaults, editorDomain } from "../client-solid/features/variations/graph.mjs";
import { encodeHistoryRecipe } from "../src/features/variations/history-codec.mjs";
import { parameterCurrent, parseExactJson, stringifyExactJson } from "../src/parameters.mjs";
import { closestChoices, destinationConflicts } from "../src/features/variations/destination.mjs";
import { sourceOrigin } from "../src/source-origin.mjs";

Deno.test("destination: closest choices rank similar model names and omit weak matches", () => {
  assertEquals(closestChoices("models/flux1-dev.safetensors", ["flux1-dev-fp8.safetensors", "sdxl.safetensors", "flux1-schnell.safetensors"]),
    ["flux1-dev-fp8.safetensors", "flux1-schnell.safetensors"]);
  assertEquals(closestChoices("abc", ["zzzzzzzz"]), []);
  const huge = 10n ** 20n;
  assertEquals(closestChoices(huge, [huge + 1n, "x"]), [huge + 1n], "exact integers never throw");
});

Deno.test("destination: conflicts are only missing classes and values outside a declared closed list", () => {
  const graph = { a: { class_type: "Ckpt" }, b: { class_type: "Fancy" }, c: { class_type: "Free" } };
  const parameters = [
    { id: "a.ckpt", nodeIds: ["a"], valueKind: "string", currentValue: "x.safetensors", schema: { status: "known", type: "COMBO", options: ["y.safetensors"] } },
    { id: "a.ok", nodeIds: ["a"], valueKind: "string", currentValue: "y.safetensors", schema: { status: "known", type: "COMBO", options: ["y.safetensors"] } },
    { id: "b.value", nodeIds: ["b"], valueKind: "number", currentValue: 1, schema: { status: "unavailable" } },
    { id: "c.text", nodeIds: ["c"], valueKind: "string", currentValue: "anything", schema: { status: "unavailable" } },
  ];
  const conflicts = destinationConflicts(parameters, graph, ["Fancy"]);
  assertEquals(Object.keys(conflicts).sort(), ["a.ckpt", "b.value"]);
  assertEquals(conflicts["a.ckpt"].kind, "value");
  assertEquals(conflicts["a.ckpt"].suggestions, [], "no similar name, no suggestion");
  assertEquals(conflicts["a.ckpt"].choices, ["y.safetensors"]);
  assertEquals(conflicts["b.value"], { kind: "node", type: "Fancy" });
});

function recipeFor(catalogue) {
  const r = makeVariationRecipe();
  r.seed("naming", "root", {}, { prefix: "", suffix: "" });
  for (const p of catalogue.parameters) {
    const domain = editorDomain(p), numeric = domain === "numeric" ? numericDefaults(p, false) : null;
    r.seed(domain, p.id, { ...p, label: p.id, ...numeric?.metadata }, numeric?.defaults ?? (domain === "images" ? { enabled: false, items: [{ kind: "reference", value: parameterCurrent(p) }] }
      : domain === "texts" ? { enabled: false, text: parameterCurrent(p), tpl: {} } : domain === "enums" ? { enabled: false, picks: [parameterCurrent(p)] }
      : { enabled: false, candidates: [stringifyExactJson(parameterCurrent(p))] }));
  }
  return r;
}

Deno.test("destination: a saved Run materializes and queues only on the chosen ComfyUI", async () => {
  const dir = await Deno.makeTempDir({ prefix: "kz-destination-" });
  const graph = { load: { class_type: "LoadImage", inputs: { image: "original.png" } },
    ckpt: { class_type: "Ckpt", inputs: { ckpt_name: "flux1-dev.safetensors" } },
    n: { class_type: "Test", inputs: { seed: 5, images: ["load", 0], model: ["ckpt", 0] } },
    save: { class_type: "SaveImage", inputs: { images: ["n", 0], filename_prefix: "source" } } };
  const hosts = {};
  const serve = (name, { ckpts, classes }) => {
    const state = { jobs: [], uploads: [], inputs: new Map(name === "a" ? [["original.png", testPng(10, 10, [20, 50, 80, 255])]] : []),
      outputs: new Map(name === "a" ? [["source_00001_.png", testPng(20, 20, [10, 30, 70, 255], graph)]] : []) };
    const info = { SaveImage: { output_node: true, input: { required: { filename_prefix: ["STRING", {}], images: ["IMAGE", {}] } }, output: [] },
      LoadImage: { input: { required: { image: [["original.png"], { image_upload: true }] } }, output: ["IMAGE"] },
      Ckpt: { input: { required: { ckpt_name: [ckpts, {}] } }, output: ["MODEL"] },
      Test: { input: { required: { seed: ["INT", {}], images: ["IMAGE", {}], model: ["MODEL", {}] } }, output: ["IMAGE"] } };
    state.server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async req => {
      const url = new URL(req.url);
      if (url.pathname === "/api/object_info") return Response.json(Object.fromEntries(Object.entries(info).filter(([type]) => classes.includes(type))));
      if (url.pathname === "/api/view") {
        const bytes = (url.searchParams.get("type") === "input" ? state.inputs : state.outputs).get(url.searchParams.get("filename"));
        return bytes ? new Response(bytes, { headers: { ETag: '"fixture"' } }) : new Response(null, { status: 404 });
      }
      if (url.pathname === "/api/upload/image") {
        const file = (await req.formData()).get("image"), bytes = new Uint8Array(await file.arrayBuffer());
        const stored = `${name}-${state.uploads.length}-${file.name}`; state.inputs.set(stored, bytes); state.uploads.push(stored);
        return Response.json({ name: stored, type: "input", subfolder: "" });
      }
      if (url.pathname === "/api/prompt") { state.jobs.push(await req.text()); return Response.json({ prompt_id: `${name}-job-${state.jobs.length}`, node_errors: {} }); }
      return new Response(null, { status: 404 });
    });
    hosts[name] = state;
  };
  serve("a", { ckpts: ["flux1-dev.safetensors"], classes: ["SaveImage", "LoadImage", "Ckpt", "Test"] });
  serve("b", { ckpts: ["flux1-dev-fp8.safetensors", "sdxl.safetensors"], classes: ["SaveImage", "LoadImage", "Ckpt", "Test"] });
  serve("c", { ckpts: ["flux1-dev.safetensors"], classes: ["SaveImage", "LoadImage", "Ckpt"] });
  serve("d", { ckpts: ["flux1-dev.safetensors"], classes: ["SaveImage", "LoadImage", "Ckpt", "Test"] });
  const env = { HOME: dir, KOZMOZOO_STATE: dir, KOZMOZOO_CACHE: `${dir}/cache`, KOZMOZOO_PLUGINS: `${dir}/no-plugins`,
    KOZMOZOO_HOSTS: ["a", "b", "c", "d"].map(name => `${name}=127.0.0.1:${hosts[name].server.addr.port}`).join(",") };
  const engine = await buildContext({ env, start: false });
  const call = async (method, path, body) => {
    const response = await engine.router.handle(new Request(`http://localhost/api/features/variations${path}`, {
      method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: stringifyExactJson(body) }) }));
    return { status: response.status, data: parseExactJson(await response.text()) };
  };
  try {
    await engine.ctx.ingest.ensure("a", "source_00001_.png");
    const probe = (await call("GET", "/probe/a%3Asource_00001_.png")).data;
    const collections = await (await engine.router.handle(new Request("http://localhost/api/collections"))).json();
    const originOf = name => sourceOrigin(name, collections[name]);
    const b = originOf("b"), c = originOf("c");
    const onB = await call("GET", `/probe/a%3Asource_00001_.png?destination=${encodeURIComponent(JSON.stringify(b))}`);
    assertEquals(onB.status, 200, stringifyExactJson(onB));
    assertEquals(onB.data.context, probe.context, "target context stays the image's own");
    assertEquals(onB.data.destination.origin, b);
    assertEquals(Object.keys(onB.data.destination.conflicts), ["ckpt.ckpt_name"]);
    assertEquals(onB.data.destination.conflicts["ckpt.ckpt_name"].suggestions, ["flux1-dev-fp8.safetensors"]);
    const onA = (await call("GET", `/probe/a%3Asource_00001_.png?destination=${encodeURIComponent(JSON.stringify(probe.context.origin))}`)).data;
    assertEquals([onA.destination.conflicts, onA.destination.missing], [{}, []], "own source keeps today's behaviour");
    const onC = (await call("GET", `/probe/a%3Asource_00001_.png?destination=${encodeURIComponent(JSON.stringify(c))}`)).data;
    assertEquals(onC.destination.missing, ["Test"]);
    assert(Object.values(onC.destination.conflicts).every(conflict => conflict.kind === "node"));
    assertEquals(onC.parameters.find(p => p.id === "n.seed").schema.status, "known", "missing classes keep original descriptors");

    // Resolve the model to B's closest choice and run there.
    const raw = recipeFor(onB.data);
    raw.write("enums", "ckpt.ckpt_name", "enabled", true); raw.write("enums", "ckpt.ckpt_name", "picks", ["flux1-dev-fp8.safetensors"]);
    const target = { id: "a:source_00001_.png", host: "a", filename: "source_00001_.png", origin: probe.context.origin, context: probe.context };
    const runId = crypto.randomUUID(), encoded = encodeHistoryRecipe(raw.capture(), runId);
    assertEquals((await call("POST", "/history", { runId, format: 1, cohortMode: "single", targets: [target], recipe: encoded.recipe, resources: encoded.resources, destination: b })).status, 200);
    const prepared = await call("POST", `/history/${runId}/prepare`);
    assertEquals(prepared.status, 200, stringifyExactJson(prepared));
    assertEquals((await call("POST", `/history/${runId}/uploads/0-${Object.values(prepared.data.targets[0].graphResources)[0]}`,
      { targetIndex: 0, resourceId: Object.values(prepared.data.targets[0].graphResources)[0], origin: probe.context.origin, snapshotHash: prepared.data.snapshotHash })).status, 412,
      "the image's own source is not this Run's destination");
    for (const resourceId of new Set(Object.values(prepared.data.targets[0].graphResources))) {
      const uploaded = await call("POST", `/history/${runId}/uploads/0-${resourceId}`, { targetIndex: 0, resourceId, origin: b, snapshotHash: prepared.data.snapshotHash });
      assertEquals(uploaded.status, 200, stringifyExactJson(uploaded));
    }
    const plan = await call("POST", `/history/${runId}/prepare-target`, { targetIndex: 0, origin: b, snapshotHash: prepared.data.snapshotHash });
    assertEquals(plan.status, 200, stringifyExactJson(plan));
    assertEquals(plan.data.request.context.origin, b);
    const submitted = await call("POST", "/run", plan.data.request);
    assertEquals(submitted.status, 200, stringifyExactJson(submitted));
    assertEquals(submitted.data.submitted, 1);
    assertEquals([hosts.a.jobs.length, hosts.a.uploads.length, hosts.b.jobs.length, hosts.b.uploads.length], [0, 0, 1, 1]);
    const job = parseExactJson(hosts.b.jobs[0]).prompt;
    assertEquals(job.ckpt.inputs.ckpt_name, "flux1-dev-fp8.safetensors");
    assertEquals(hosts.b.inputs.get(job.load.inputs.image), hosts.a.inputs.get("original.png"));
    assertEquals(parseExactJson(engine.ctx.store.variationGet(runId).recipe_json).destination, b);

    // Two targets sharing input bytes upload them to the destination once.
    const twinId = crypto.randomUUID(), twin = encodeHistoryRecipe(raw.capture(), twinId);
    assertEquals((await call("POST", "/history", { runId: twinId, format: 1, cohortMode: "bulk", targets: [target, target], recipe: twin.recipe, resources: twin.resources, destination: b })).status, 200);
    const twinPrepared = await call("POST", `/history/${twinId}/prepare`);
    assertEquals(twinPrepared.status, 200, stringifyExactJson(twinPrepared));
    const uploadsBefore = hosts.b.uploads.length;
    for (const index of [0, 1]) for (const resourceId of new Set(Object.values(twinPrepared.data.targets[index].graphResources))) {
      const uploaded = await call("POST", `/history/${twinId}/uploads/${index}-${resourceId}`, { targetIndex: index, resourceId, origin: b, snapshotHash: twinPrepared.data.snapshotHash });
      assertEquals(uploaded.status, 200, stringifyExactJson(uploaded));
      assertEquals(uploaded.data.reused, index === 1);
    }
    assertEquals(hosts.b.uploads.length, uploadsBefore + 1);

    // The host is compared too: the unchanged seed is a new image on d, and
    // nothing to submit on the image's own host a.
    const unchanged = destination => {
      const raw = recipeFor(onB.data); raw.write("numeric", "n.seed", "enabled", true); raw.write("numeric", "n.seed", "mode", "value"); raw.write("numeric", "n.seed", "value", "5");
      const runId = crypto.randomUUID(), encoded = encodeHistoryRecipe(raw.capture(), runId);
      return { runId, body: { runId, format: 1, cohortMode: "single", targets: [target], recipe: encoded.recipe, resources: encoded.resources, destination } };
    };
    const dOrigin = originOf("d"), onD = unchanged(dOrigin);
    assertEquals((await call("POST", "/history", onD.body)).status, 200);
    const dPrepared = (await call("POST", `/history/${onD.runId}/prepare`)).data;
    for (const resourceId of new Set(Object.values(dPrepared.targets[0].graphResources)))
      assertEquals((await call("POST", `/history/${onD.runId}/uploads/0-${resourceId}`, { targetIndex: 0, resourceId, origin: dOrigin, snapshotHash: dPrepared.snapshotHash })).status, 200);
    const dPlan = await call("POST", `/history/${onD.runId}/prepare-target`, { targetIndex: 0, origin: dOrigin, snapshotHash: dPrepared.snapshotHash });
    assertEquals(dPlan.status, 200, stringifyExactJson(dPlan));
    const dRun = await call("POST", "/run", dPlan.data.request);
    assertEquals([dRun.status, dRun.data.submitted, dRun.data.total], [200, 1, 1], stringifyExactJson(dRun));
    assertEquals(parseExactJson(hosts.d.jobs[0]).prompt.n.inputs.seed, 5);
    const own = unchanged(probe.context.origin);
    assertEquals((await call("POST", "/history", own.body)).status, 200);
    const aPrepared = (await call("POST", `/history/${own.runId}/prepare`)).data;
    for (const resourceId of new Set(Object.values(aPrepared.targets[0].graphResources)))
      await call("POST", `/history/${own.runId}/uploads/0-${resourceId}`, { targetIndex: 0, resourceId, origin: probe.context.origin, snapshotHash: aPrepared.snapshotHash });
    const aPlan = await call("POST", `/history/${own.runId}/prepare-target`, { targetIndex: 0, origin: probe.context.origin, snapshotHash: aPrepared.snapshotHash });
    assertEquals(aPlan.status, 400, stringifyExactJson(aPlan));
    assertEquals(hosts.a.jobs.length, 0);

    // A host lacking a node class rejects before any upload or job.
    const blockedId = crypto.randomUUID(), blocked = encodeHistoryRecipe(recipeFor(onC).capture(), blockedId);
    const seeded = recipeFor(onC); seeded.write("numeric", "n.seed", "enabled", true); seeded.write("numeric", "n.seed", "mode", "value"); seeded.write("numeric", "n.seed", "value", "6");
    const blockedRecipe = encodeHistoryRecipe(seeded.capture(), blockedId);
    assertEquals((await call("POST", "/history", { runId: blockedId, format: 1, cohortMode: "single", targets: [target], recipe: blockedRecipe.recipe, resources: blocked.resources, destination: c })).status, 200);
    const blockedPrepared = await call("POST", `/history/${blockedId}/prepare`);
    assertEquals(blockedPrepared.status, 200, stringifyExactJson(blockedPrepared));
    const resourceId = Object.values(blockedPrepared.data.targets[0].graphResources)[0];
    const blockedUpload = await call("POST", `/history/${blockedId}/uploads/0-${resourceId}`, { targetIndex: 0, resourceId, origin: c, snapshotHash: blockedPrepared.data.snapshotHash });
    assertEquals(blockedUpload.status, 409, stringifyExactJson(blockedUpload));
    assert(blockedUpload.data.error.includes("Not installed on c: Test"));
    const blockedPlan = await call("POST", `/history/${blockedId}/prepare-target`, { targetIndex: 0, origin: c, snapshotHash: blockedPrepared.data.snapshotHash });
    assertEquals(blockedPlan.status, 409);
    assertEquals([hosts.c.jobs.length, hosts.c.uploads.length], [0, 0]);
  } finally {
    await engine.close();
    for (const host of Object.values(hosts)) await host.server.shutdown();
  }
});
