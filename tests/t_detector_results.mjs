import { assertEquals, assertThrows } from "jsr:@std/assert";
import { decodeDetectionResult } from "../src/detection-result.mjs";
import { register } from "../plugins/detector/plugin.mjs";
import { sha256, isContentHash } from "../src/cache.mjs";

const face = { bbox: [-1, 0, 9, 10], score: 1.01, kps: [[1, 2, 1.02], [5, 2, -0.1]] };
const result = { id: 2, w: 8, h: 8, faces: [face, { bbox: [2, 3, 4, 5], score: null, kps: [] }] };

Deno.test("detector codec: all faces/order/geometry retained, box-only and genuine no-face", () => {
  assertEquals(decodeDetectionResult(result), result);
  assertEquals(decodeDetectionResult({ w: 1, h: 2, faces: [] }), { w: 1, h: 2, faces: [] });
  for (const value of [null, [], {}, { error: "decode failed" }, { ...result, error: "bad" },
    { ...result, w: 0 }, { ...result, h: -1 }, { ...result, w: Infinity }, { ...result, h: NaN },
    { ...result, faces: null }, { ...result, faces: Array(1) }, { ...result, id: "2" }]) {
    assertThrows(() => decodeDetectionResult(value), TypeError);
  }
  for (const bad of [null, {}, { ...face, bbox: [1, 0, 1, 2] }, { ...face, bbox: [2, 2, 1, 3] },
    { ...face, bbox: [0, 0, Infinity, 2] }, { ...face, bbox: [0, 0, 1] },
    { ...face, score: NaN }, { ...face, score: "1" }, { ...face, score: undefined },
    { ...face, kps: [[1, 2]] }, { ...face, kps: [[1, 2, Infinity]] },
    { ...face, kps: [[1, NaN, 1]] }, { ...face, kps: null }, { ...face, kps: [Array(3)] }]) {
    assertThrows(() => decodeDetectionResult({ ...result, faces: [bad] }), TypeError);
  }
});

function plugin(url) {
  const routes = new Map();
  const state = { url };
  register({
    settings: { get: () => state.url }, alignment() {},
    route: (method, path, fn) => routes.set(`${method} ${path}`, fn),
    content: { hash: sha256, isHash: isContentHash },
    results: { detection: decodeDetectionResult },
  });
  return {
    state,
    detect: () => routes.get("POST /detect")(new Request("http://engine/detect", { method: "POST", body: "anchor" })),
    status: () => routes.get("GET /status")(),
  };
}
const serve = handler => Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, handler);
const address = server => `http://127.0.0.1:${server.addr.port}`;
const health = deadline_ms => Response.json({ model_ready: true, model: "fixture", deadline_ms });
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };

Deno.test("detector boundary: validated success, raw hash, malformed/error documents fail", async () => {
  let response = result, raw = false;
  const svc = serve(req => new URL(req.url).pathname === "/health" ? health(1000) :
    raw ? new Response("not JSON") : Response.json(response));
  const p = plugin(address(svc));
  try {
    let res = await p.detect();
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ...result, image: { hash: await sha256(new TextEncoder().encode("anchor")) },
      detector: { serviceUrl: address(svc), model: "fixture" } });
    response = { w: 1, h: 1, faces: [] };
    res = await p.detect();
    assertEquals((await res.json()).faces, []);
    for (const bad of [{ error: "worker cannot decode" }, {}, { w: 0, h: 1, faces: [] },
      { ...result, faces: [{ ...face, bbox: [1, 1, 0, 0] }] }]) {
      response = bad;
      res = await p.detect();
      assertEquals(res.status, 502);
      const data = await res.json();
      assertEquals(data.error, "service error");
      assertEquals(Object.hasOwn(data, "faces"), false);
      if (bad.error) assertEquals(data.reason.includes(bad.error), true, "worker diagnostics survive HTTP 200");
    }
    raw = true;
    res = await p.detect();
    assertEquals(res.status, 502);
    await res.json();
  } finally { await svc.shutdown(); }
});

Deno.test("detector configuration: new URL cannot reuse deadline, invalid deadlines never infer", async () => {
  let deadline = 100, calls = 0, probes = 0;
  const a = serve(req => new URL(req.url).pathname === "/health" ? health(60000) : Response.json(result));
  const b = serve(req => {
    if (new URL(req.url).pathname === "/health") { probes++; return health(deadline); }
    calls++; return Response.json(result);
  });
  const p = plugin(address(a));
  try {
    await (await p.detect()).json();
    p.state.url = address(b);
    for (const invalid of [0, -1, null, "100", 1e30]) {
      deadline = invalid;
      const res = await p.detect();
      assertEquals(res.status, 503);
      await res.json();
    }
    assertEquals(calls, 0);
    assertEquals(probes, 5);
    deadline = 100;
    assertEquals((await (await p.status()).json()).deadlineMs, 100);
    const res = await p.detect();
    assertEquals(res.status, 200);
    await res.json();
    assertEquals(calls, 1);
    assertEquals(probes, 6);
  } finally { await a.shutdown(); await b.shutdown(); }
});

for (const phase of ["health", "detect"]) Deno.test(`detector configuration: URL change during ${phase} fences stale completion`, async () => {
  const entered = deferred(), release = deferred();
  let detectionsA = 0, detectionsB = 0;
  const a = serve(async req => {
    const path = new URL(req.url).pathname;
    if (path === "/detect") detectionsA++;
    if (path === `/${phase}`) { entered.resolve(); await release.promise; }
    return path === "/health" ? health(60000) : Response.json(result);
  });
  const b = serve(req => {
    if (new URL(req.url).pathname === "/health") return health(200);
    detectionsB++; return Response.json({ w: 4, h: 5, faces: [] });
  });
  const p = plugin(address(a));
  try {
    const pending = p.detect();
    await entered.promise;
    p.state.url = address(b);
    const bStatus = await p.status();
    assertEquals((await bStatus.json()).deadlineMs, 200);
    release.resolve();
    const res = await pending;
    assertEquals(res.status, 409);
    await res.json();
    assertEquals(detectionsA, phase === "detect" ? 1 : 0);
    assertEquals(detectionsB, 0, "old operation never retargets the new service");
    const next = await p.detect();
    assertEquals(next.status, 200);
    const value = await next.json();
    assertEquals(value.w, 4);
    assertEquals(value.detector.serviceUrl, address(b));
    assertEquals(detectionsB, 1);
  } finally { release.resolve(); await a.shutdown(); await b.shutdown(); }
});
