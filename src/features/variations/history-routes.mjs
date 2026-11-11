import { makeVariationHistory } from "./history.mjs";
import { parseExactJson, stringifyExactJson } from "../../parameters.mjs";
import { bytesResponse, readJson } from "../../routes.mjs";
import { sniffMime } from "../../extractor.mjs";
import { validOrigin } from "../../source-origin.mjs";
import { isContentHash } from "../../content-hash.mjs";

export const historyResponse = (value, status = 200) => new Response(stringifyExactJson(value), { status, headers: { "Content-Type": "application/json" } });
export function registerHistory(app) {
  const owner = makeVariationHistory(app);
  // No SQL or archive I/O at feature registration, including legacy narrow rigs.
  const route = (method, path, handler) => app.route(method, path, (req, params) => app.lifetime.run(`history ${method} ${path}`, async () => {
    try { return await handler(req, params); }
    catch (error) { return historyResponse({ error: error.message }, error.status ?? 500); }
  }));
  const json = async req => {
    try { return await readJson(req, { parse: parseExactJson }); }
    catch { throw Object.assign(new Error("JSON body required"), { status: 400 }); }
  };
  const targetBody = async req => {
    const body = await json(req);
    if (!body || !Number.isSafeInteger(body.targetIndex) || body.targetIndex < 0 || !validOrigin(body.origin) || !isContentHash(body.snapshotHash)) {
      throw Object.assign(new Error("Valid target index, source origin and snapshot hash required"), { status: 400 });
    }
    return body;
  };
  route("GET", "/history", req => {
    const query = new URL(req.url).searchParams, raw = query.get("limit") ?? "50";
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 100) return historyResponse({ error: "Invalid page limit" }, 400);
    const limit = Number(raw);
    let before;
    try {
      if (query.has("before")) {
        before = JSON.parse(atob(query.get("before")));
        if (!Number.isSafeInteger(before.at) || typeof before.id !== "string" || Object.keys(before).length !== 2) throw new Error();
      }
    } catch { return historyResponse({ error: "Invalid history cursor" }, 400); }
    const rows = app.store.variationList(limit + 1, before), hasNext = rows.length > limit, page = rows.slice(0, limit);
    const last = page.at(-1);
    return historyResponse({ format: 1, revision: app.store.variationRevision(),
      items: page.map(row => ({ id: row.id, createdAt: row.created_at, format: row.format, captureState: row.capture_state, outcome: row.outcome,
        summary: { ...parseExactJson(row.summary_json), submitted: row.submitted_count, total: row.total_count, plannedCount: row.planned_count } })),
      nextCursor: hasNext ? btoa(JSON.stringify({ at: last.created_at, id: last.id })) : null });
  });
  route("POST", "/history", async req => {
    const body = await json(req);
    try { const row = owner.begin(body); return historyResponse({ id: row.id, captureState: row.capture_state }); }
    catch (error) { return historyResponse({ error: error.message }, error.status ?? 400); }
  });
  route("GET", "/history/<id>", (_req, { id }) => historyResponse(owner.detail(id)));
  route("PUT", "/history/<id>/resources/<resourceId>", async (req, { id, resourceId }) => {
    if ((req.headers.get("Content-Type") ?? "").split(";", 1)[0] !== "application/octet-stream") return historyResponse({ error: "Image bytes required" }, 415);
    return historyResponse(await owner.uploadBytes(id, resourceId, new Uint8Array(await req.arrayBuffer())));
  });
  route("POST", "/history/<id>/prepare", async (_req, { id }) => historyResponse(await owner.prepare(id)));
  route("POST", "/history/<id>/open", async (_req, { id }) => historyResponse(await owner.open(id)));
  route("DELETE", "/history/<id>/leases/<leaseId>", async (_req, { id, leaseId }) => { await owner.release(id, leaseId); return historyResponse({ released: true }); });
  route("GET", "/history/<id>/resources/<resourceId>/bytes", async (req, { id, resourceId }) => {
    const bytes = await owner.bytes(id, resourceId, new URL(req.url).searchParams.get("lease"));
    const ref = app.store.variationResource(id, resourceId);
    return bytesResponse(req, bytes, ref.hash, sniffMime(bytes));
  });
  route("POST", "/history/<id>/uploads/<effectId>", async (req, { id, effectId }) => {
    const body = await targetBody(req);
    if (effectId !== `${body.targetIndex}-${body.resourceId}`) return historyResponse({ error: "Invalid upload effect identity" }, 400);
    return historyResponse(await owner.materialize(id, body.targetIndex, body.resourceId, body.origin, body.snapshotHash));
  });
  route("POST", "/history/<id>/prepare-target", async (req, { id }) => {
    const body = await targetBody(req);
    let plan;
    try { plan = await owner.prepareTarget(id, body.targetIndex, body.origin, body.snapshotHash); }
    catch (error) { return historyResponse({ error: error.message }, error.status ?? 400); }
    // The registered graph stays engine-private; clients receive request/proof only.
    const { graph: _graph, ...publicPlan } = plan;
    return historyResponse(publicPlan);
  });
  route("POST", "/history/<id>/finish", async (req, { id }) => historyResponse(owner.finish(id, (await json(req)).error)));
  route("DELETE", "/history/<id>", async (_req, { id }) => { await owner.remove(id); return historyResponse({ deleted: true }); });
  return owner;
}
