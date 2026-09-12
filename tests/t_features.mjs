// tests/t_features.mjs — the variations feature on the engine surface:
// probe inspects the embedded graph via the feature route; run mutates +
// enqueues per permutation through the comfy backing (with a hard cap).

import { assert, assertEquals } from "jsr:@std/assert";
import { buildContext } from "../src/context.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURES = new URL("./fixtures", import.meta.url).pathname;

async function featureCtx(dir) {
  const { ctx, router } = await buildContext({
    env: {
      HOME: dir,
      KOZMOZOO_STATE: dir,
      KOZMOZOO_CACHE: join(dir, "cache"),
      KOZMOZOO_HOSTS: `fixtures=folder:${FIXTURES}`,
      KOZMOZOO_PLUGINS: join(dir, "no-plugins"), // features are not plugins
    },
    start: false,
  });
  return { ctx, router };
}

Deno.test("features: probe reads the embedded graph through /api/features/variations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-feat-"));
  const { ctx, router } = await featureCtx(dir);

  // folder collections have no object_info — types come back null, the
  // probe still inspects (value inference)
  await ctx.ingest.ensure("fixtures", "flux-lora.png");
  const r = await router.handle(new Request(
    "http://x/api/features/variations/probe/" + encodeURIComponent("fixtures:flux-lora.png"),
  ));
  assertEquals(r.status, 200);
  const body = await r.json();
  assert(body.params.length > 0, "numeric params discovered");
  const ids = body.params.map((p) => p.id);
  assert(ids.includes("BasicScheduler.steps"), `steps in ${ids}`);

  // unknown image 404s
  const nf = await router.handle(new Request(
    "http://x/api/features/variations/probe/" + encodeURIComponent("fixtures:nope.png"),
  ));
  assertEquals(nf.status, 404);
  ctx.prefetch.stop();
  await rm(dir, { recursive: true, force: true });
});

Deno.test("features: run enqueues per permutation, caps at 413, no host# tag", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-featrun-"));

  // a fake comfy host that records prompts
  const enqueued = [];
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
    const p = new URL(req.url).pathname;
    if (p === "/api/prompt") { enqueued.push(1); return Response.json({ ok: true }); }
    if (p === "/api/object_info") return Response.json({ SaveImage: { output_node: true, input: {} }, KSampler: { input: { required: { steps: ["INT"], denoise: ["FLOAT"] } } } });
    if (p === "/api/view") {
      return new Response(Deno.readFileSync(join(FIXTURES, "flux-lora.png")), { headers: { ETag: '"e1"' } });
    }
    return new Response("nf", { status: 404 });
  });
  const addr = `127.0.0.1:${server.addr.port}`;

  const { ctx, router } = await buildContext({
    env: {
      HOME: dir, KOZMOZOO_STATE: dir, KOZMOZOO_CACHE: join(dir, "cache"),
      KOZMOZOO_HOSTS: `fake=${addr}`,
      KOZMOZOO_PLUGINS: join(dir, "no-plugins"),
    },
    start: false,
  });
  await ctx.ingest.ensure("fake", "flux-lora.png");

  const run = (ranges) => router.handle(new Request("http://x/api/features/variations/run", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "fake:flux-lora.png", host: "fake", filename: "flux-lora.png",
      ranges,
      prefix: "v_", suffix: "",
    }),
  }));

  // steps 20..21: the graph's CURRENT 20 is excluded (current-combo rule),
  // only 21 enqueues
  let r = await run({ "BasicScheduler.steps": { enabled: true, min: 20, max: 21, increment: 1 } });
  let body = await r.json();
  assertEquals(r.status, 200);
  assertEquals(body.submitted, 1);
  assertEquals(body.total, 1); // total is post-exclusion
  assertEquals(enqueued.length, 1);

  // over the cap → 413
  r = await run({ "BasicScheduler.denoise": { enabled: true, min: 0, max: 1, increment: 0.001 } });
  assertEquals(r.status, 413);

  // a range without increment → 400 (the legacy global fallback is gone)
  r = await run({ "BasicScheduler.steps": { enabled: true, min: 20, max: 21 } });
  assertEquals(r.status, 400);

  await server.shutdown();
  ctx.prefetch.stop();
  await rm(dir, { recursive: true, force: true });
});
