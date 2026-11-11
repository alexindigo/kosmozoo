import { assert, assertEquals } from "jsr:@std/assert";
import { buildContext } from "../src/context.mjs";
import { ContentArchive } from "../src/content-archive.mjs";
import { testPng } from "./helpers/png.mjs";
import { makeVariationRecipe } from "../client-solid/features/variations/recipe.js";
import { numericDefaults, editorDomain } from "../client-solid/features/variations/graph.mjs";
import { encodeHistoryRecipe } from "../src/features/variations/history-codec.mjs";
import { parameterCurrent, parseExactJson, stringifyExactJson } from "../src/parameters.mjs";
import { snapshotDraft } from "../src/features/variations/recipe-model.mjs";

function recipeFor(catalogue) {
  const r = makeVariationRecipe();
  r.seed("naming", "root", {}, { prefix: "", suffix: "" });
  for (const p of catalogue.parameters) {
    const domain = editorDomain(p), label = p.id;
    const numeric = domain === "numeric" ? numericDefaults(p, false) : null;
    r.seed(domain, p.id, { ...p, label, ...numeric?.metadata }, numeric?.defaults ?? (domain === "images" ? { enabled: false, items: [{ kind: "reference", value: parameterCurrent(p) }] }
      : domain === "texts" ? { enabled: false, text: parameterCurrent(p), tpl: {} }
      : { enabled: false, candidates: [stringifyExactJson(parameterCurrent(p))] }));
  }
  r.write("numeric", "n.seed", "enabled", true);
  r.write("numeric", "n.seed", "mode", "value");
  r.write("numeric", "n.seed", "value", "18446744073709551614");
  return r;
}

Deno.test("history HTTP: immutable raw capture/archive barrier, engine plan and idempotent exact final effects", async () => {
  const dir = await Deno.makeTempDir({ prefix: "kz-history-run-" });
  const graph = { load: { class_type: "LoadImage", inputs: { image: "original.png" } },
    n: { class_type: "Test", inputs: { seed: JSON.rawJSON("18446744073709551615"), images: ["load", 0] } },
    save: { class_type: "SaveImage", inputs: { images: ["n", 0], filename_prefix: "source" } } };
  const original = testPng(10, 10, [20, 50, 80, 255]);
  const outputs = new Map([["source_00001_.png", testPng(20, 20, [10, 30, 70, 255], graph)]]), inputs = new Map([["original.png", original]]);
  const jobs = [], uploads = [];
  let acceptance = "confirmed";
  const fake = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async req => {
    const url = new URL(req.url);
    if (url.pathname === "/api/object_info") return Response.json({ SaveImage: { output_node: true, input: {} } });
    if (url.pathname === "/api/view") {
      const bytes = (url.searchParams.get("type") === "input" ? inputs : outputs).get(url.searchParams.get("filename"));
      return bytes ? new Response(bytes, { headers: { ETag: '"fixture"' } }) : new Response(null, { status: 404 });
    }
    if (url.pathname === "/api/upload/image") {
      const file = (await req.formData()).get("image"), bytes = new Uint8Array(await file.arrayBuffer());
      const name = `archived-${uploads.length}-${file.name}`; inputs.set(name, bytes); uploads.push({ name, bytes });
      return Response.json({ name, type: "input", subfolder: "" });
    }
    if (url.pathname === "/api/prompt") {
      jobs.push(await req.text());
      return Response.json(acceptance === "uncertain" ? {} : { prompt_id: `job-${jobs.length}`, node_errors: acceptance === "partial" ? { save: { errors: ["fixture"] } } : {} });
    }
    return new Response(null, { status: 404 });
  });
  const env = { HOME: dir, KOZMOZOO_STATE: dir, KOZMOZOO_CACHE: `${dir}/cache`, KOZMOZOO_HOSTS: `fake=127.0.0.1:${fake.addr.port}`, KOZMOZOO_PLUGINS: `${dir}/no-plugins` };
  let engine = await buildContext({ env, start: false });
  const call = async (method, path, body) => {
    const response = await engine.router.handle(new Request(`http://localhost/api/features/variations${path}`, {
      method, headers: body === undefined ? {} : { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: stringifyExactJson(body) }),
    }));
    return { status: response.status, data: parseExactJson(await response.text()) };
  };
  const materialize = async detail => {
    const target = detail.targets[0], captured = engine.ctx.store.variationGet(detail.id), origin = parseExactJson(captured.targets_json)[0].origin;
    for (const resourceId of Object.values(target.graphResources)) {
      const uploaded = await call("POST", `/history/${detail.id}/uploads/0-${resourceId}`, { targetIndex: 0, resourceId, origin, snapshotHash: detail.snapshotHash });
      assertEquals(uploaded.status, 200, stringifyExactJson(uploaded));
    }
    return origin;
  };
  try {
    await engine.ctx.ingest.ensure("fake", "source_00001_.png");
    const probe = (await call("GET", "/probe/fake%3Asource_00001_.png")).data;
    const raw = recipeFor(probe), id = crypto.randomUUID(), encoded = encodeHistoryRecipe(raw.capture(), id);
    const target = { id: "fake:source_00001_.png", host: "fake", filename: "source_00001_.png", origin: probe.context.origin, context: probe.context };
    const capture = { runId: id, format: 1, cohortMode: "single", targets: [target], recipe: encoded.recipe, resources: encoded.resources };
    assertEquals((await call("POST", "/history", capture)).status, 200);
    assertEquals((await call("POST", "/history", capture)).status, 200);
    assertEquals(jobs.length + uploads.length, 0);
    assertEquals((await call("POST", `/history/${id}/prepare-target`, { targetIndex: 0, origin: target.origin, snapshotHash: "a".repeat(64) })).status, 409);
    const prepared = await call("POST", `/history/${id}/prepare`);
    assertEquals(prepared.status, 200, stringifyExactJson(prepared));
    assertEquals(jobs.length + uploads.length, 0);
    assertEquals((await call("POST", "/history", capture)).status, 200, "same initial capture remains idempotent after derived graph resources are reserved");
    const origin = await materialize(prepared.data);
    const plan = await call("POST", `/history/${id}/prepare-target`, { targetIndex: 0, origin, snapshotHash: prepared.data.snapshotHash });
    assertEquals(plan.status, 200, stringifyExactJson(plan));
    assertEquals((await call("POST", `/history/${id}/prepare-target`, { targetIndex: 0, origin, snapshotHash: prepared.data.snapshotHash })).data, plan.data);
    const submitted = await call("POST", "/run", plan.data.request);
    assertEquals(submitted.status, 200, stringifyExactJson(submitted));
    assertEquals(submitted.data.submitted, 1);
    assertEquals(parseExactJson(jobs[0]).prompt.n.inputs.seed, 18446744073709551614n);
    assertEquals((await call("POST", "/run", plan.data.request)).data, submitted.data);
    assertEquals((await call("POST", "/run", { ...plan.data.request, history: { ...plan.data.request.history, planHash: "0".repeat(64) } })).status, 409);
    assertEquals(jobs.length, 1);
    const snapshot = engine.ctx.store.variationGet(id).snapshot_json;
    await engine.close();
    // Ordinary cache and originals are not the saved configuration's identity.
    await Deno.remove(`${dir}/cache`, { recursive: true }); outputs.clear(); inputs.clear();
    engine = await buildContext({ env, start: false });
    const opened = await call("POST", `/history/${id}/open`);
    assertEquals(opened.status, 200, stringifyExactJson(opened));
    assertEquals(opened.data.recipe.numeric["n.seed"].values.value, "18446744073709551614");
    const nextId = crypto.randomUUID(), next = encodeHistoryRecipe(opened.data.recipe, nextId), recalled = opened.data.targets[0];
    const nextTarget = { id: recalled.id, host: recalled.host, filename: recalled.filename, origin: recalled.origin, context: recalled.context, historyRef: recalled.historyRef };
    assertEquals((await call("POST", "/history", { runId: nextId, format: 1, cohortMode: "single", targets: [nextTarget], recipe: next.recipe, resources: next.resources })).status, 200);
    const nextPrepared = await call("POST", `/history/${nextId}/prepare`);
    assertEquals(nextPrepared.status, 200, stringifyExactJson(nextPrepared));
    const nextOrigin = await materialize(nextPrepared.data);
    const nextPlan = await call("POST", `/history/${nextId}/prepare-target`, { targetIndex: 0, origin: nextOrigin, snapshotHash: nextPrepared.data.snapshotHash });
    assertEquals(nextPlan.status, 200, stringifyExactJson(nextPlan));
    assertEquals((await call("POST", "/run", nextPlan.data.request)).data.submitted, 1);
    assertEquals(jobs.length, 2);
    assertEquals(parseExactJson(jobs[1]).prompt.n.inputs.seed, 18446744073709551614n);
    const assigned = parseExactJson(jobs[1]).prompt.load.inputs.image;
    assertEquals(inputs.get(assigned), original);
    assertEquals(engine.ctx.store.variationGet(id).snapshot_json, snapshot);
    assertEquals((await call("GET", "/history")).data.items.length, 2);
    // Deleting the original row cannot revoke the already opened draft's bytes.
    assertEquals((await call("DELETE", `/history/${id}`)).status, 200);
    assertEquals((await call("DELETE", `/history/${id}`)).status, 200);
    const retained = await engine.router.handle(new Request(`http://localhost/api/features/variations/history/${id}/resources/target-0/bytes?lease=${opened.data.leaseId}`));
    assertEquals(retained.status, 200);
    assertEquals((await call("GET", `/history/${id}`)).status, 410);
    for (const mode of ["partial", "uncertain", "storage-failure"]) {
      acceptance = mode === "storage-failure" ? "confirmed" : mode;
      const runId = crypto.randomUUID(), encoded = encodeHistoryRecipe(opened.data.recipe, runId);
      assertEquals((await call("POST", "/history", { runId, format: 1, cohortMode: "single", targets: [nextTarget], recipe: encoded.recipe, resources: encoded.resources })).status, 200);
      const saved = await call("POST", `/history/${runId}/prepare`);
      assertEquals(saved.status, 200, stringifyExactJson(saved));
      const origin = await materialize(saved.data);
      const p = await call("POST", `/history/${runId}/prepare-target`, { targetIndex: 0, origin, snapshotHash: saved.data.snapshotHash });
      assertEquals(p.status, 200, stringifyExactJson(p));
      const before = jobs.length;
      const saveResult = engine.ctx.store.variationEffectResult.bind(engine.ctx.store);
      if (mode === "storage-failure") engine.ctx.store.variationEffectResult = (...args) => {
        if (args[1].startsWith("job-")) throw new Error("fixture receipt disk failure");
        return saveResult(...args);
      };
      const result = await call("POST", "/run", p.data.request);
      engine.ctx.store.variationEffectResult = saveResult;
      if (mode === "storage-failure") {
        assertEquals(result.status, 500);
        assert(result.data.error.includes("receipt disk failure"));
        assertEquals(engine.ctx.store.variationEffects(runId).find(e => e.kind === "permutation").state, "started");
      } else assertEquals(result.data.outcome, mode === "partial" ? "partial-effects" : "uncertain-effects");
      assertEquals(jobs.length, before + 1);
      await call("POST", "/run", p.data.request);
      assertEquals(jobs.length, before + 1, "repeated partial/uncertain dispatch never re-enters enqueue");
    }
    const invalidId = crypto.randomUUID(), invalidRecipe = snapshotDraft(opened.data.recipe);
    invalidRecipe.numeric["n.seed"].values.value = "1e";
    const invalid = encodeHistoryRecipe(invalidRecipe, invalidId), beforeInvalid = { jobs: jobs.length, uploads: uploads.length };
    assertEquals((await call("POST", "/history", { runId: invalidId, format: 1, cohortMode: "single", targets: [nextTarget], recipe: invalid.recipe, resources: invalid.resources })).status, 200);
    assertEquals((await call("POST", `/history/${invalidId}/prepare`)).status, 400);
    assertEquals((await call("POST", `/history/${invalidId}/prepare`)).status, 400);
    assertEquals((await call("GET", `/history/${invalidId}`)).data.recipe.numeric["n.seed"].values.value, "1e");
    assertEquals({ jobs: jobs.length, uploads: uploads.length }, beforeInvalid);
    acceptance = "confirmed";
    const largeId = crypto.randomUUID(), largeRecipe = snapshotDraft(opened.data.recipe);
    const images = Array.from({ length: 80 }, (_, i) => testPng(8, 8, [i * 3, 40, 180 - i, 255]));
    largeRecipe.images["load.image"].values.enabled = true;
    largeRecipe.images["load.image"].values.items = images.map(bytes => ({ kind: "upload", name: "same.png", file: new File([bytes], "same.png") }));
    const large = encodeHistoryRecipe(largeRecipe, largeId);
    assertEquals((await call("POST", "/history", { runId: largeId, format: 1, cohortMode: "single", targets: [nextTarget], recipe: large.recipe, resources: large.resources })).status, 200);
    const beforeArchive = { jobs: jobs.length, uploads: uploads.length };
    assertEquals((await call("POST", `/history/${largeId}/prepare`)).status, 409, "missing browser bytes cannot pass the archive barrier");
    for (const [resourceId, file] of large.files) {
      const r = await engine.router.handle(new Request(`http://localhost/api/features/variations/history/${largeId}/resources/${resourceId}`, {
        method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file,
      }));
      assertEquals(r.status, 200);
    }
    const largePrepared = await call("POST", `/history/${largeId}/prepare`);
    assertEquals(largePrepared.status, 200, stringifyExactJson(largePrepared));
    assertEquals({ jobs: jobs.length, uploads: uploads.length }, beforeArchive);
    const largeOrigin = await materialize(largePrepared.data);
    for (const item of large.recipe.images["load.image"].values.items) {
      const resourceId = item.resourceId;
      const r = await call("POST", `/history/${largeId}/uploads/0-${resourceId}`, { targetIndex: 0, resourceId, origin: largeOrigin, snapshotHash: largePrepared.data.snapshotHash });
      assertEquals(r.status, 200, stringifyExactJson(r));
    }
    const largePlan = await call("POST", `/history/${largeId}/prepare-target`, { targetIndex: 0, origin: largeOrigin, snapshotHash: largePrepared.data.snapshotHash });
    assertEquals(largePlan.status, 200, stringifyExactJson(largePlan));
    assertEquals(largePlan.data.expectedTotal, 80);
    const largeRun = await call("POST", "/run", largePlan.data.request);
    assertEquals(largeRun.data.submitted, 80, stringifyExactJson(largeRun));
    for (let i = 0; i < 80; i++) assertEquals(inputs.get(parseExactJson(jobs[beforeArchive.jobs + i]).prompt.load.inputs.image), images[i]);
    const largeSummary = (await call("GET", "/history")).data.items.find(item => item.id === largeId).summary;
    assertEquals(largeSummary.parameters.find(p => p.id === "load.image").count, 80);
    assertEquals(largeSummary.parameters.find(p => p.id === "load.image").images.length, 4, "list summaries must not carry 80 image payloads");
    const beforeFailure = { jobs: jobs.length, uploads: uploads.length };
    await engine.close();
    const FailingArchive = class extends ContentArchive { retain() { throw new Error("fixture disk full"); } };
    engine = await buildContext({ env, start: false, fakes: { archive: new FailingArchive(`${dir}/archives`) } });
    const opening = await call("POST", `/history/${nextId}/open`), restoredTarget = opening.data.targets[0];
    const failedId = crypto.randomUUID(), failed = encodeHistoryRecipe(opening.data.recipe, failedId);
    const failedTarget = { id: restoredTarget.id, host: restoredTarget.host, filename: restoredTarget.filename, origin: restoredTarget.origin, context: restoredTarget.context, historyRef: restoredTarget.historyRef };
    assertEquals((await call("POST", "/history", { runId: failedId, format: 1, cohortMode: "single", targets: [failedTarget], recipe: failed.recipe, resources: failed.resources })).status, 200);
    const failure = await call("POST", `/history/${failedId}/prepare`);
    assertEquals(failure.status, 500);
    assert(failure.data.error.includes("disk full"));
    assertEquals({ jobs: jobs.length, uploads: uploads.length }, beforeFailure);
    assertEquals((await call("GET", `/history/${failedId}`)).data.recipe.numeric["n.seed"].values.value, "18446744073709551614");
  } finally { await engine.close(); await fake.shutdown(); }
});
