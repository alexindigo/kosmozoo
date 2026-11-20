import { problemFrom } from "./problems.mjs";
import { parseExactJson, stringifyExactJson } from "../../parameters.mjs";
export function problemEnvelope(body, context = {}) {
  if (!body || typeof body !== "object") return body;
  if (body.error) body.problem = body.problem ? problemFrom({ problem: body.problem }, context) : problemFrom({ error: body.error }, context);
  if (Array.isArray(body.errors)) body.errors = body.errors.map(error => ({ ...error, problem: problemFrom(error, context) }));
  return body;
}
// The feature's single HTTP problem boundary. Legacy error strings remain for
// existing API consumers; structured evidence is additive and survives catches.
export function problemRoutes(app) {
  return { ...app, route(method, path, handler) {
    app.route(method, path, async (req, params) => {
      const context = { phase: path.includes("history") ? "history" : path.includes("run") ? "submission" : "inspection" };
      if (path.includes("probe") && params.id) {
        const split = params.id.indexOf(":");
        context.target = { source: split < 0 ? "unknown source" : params.id.slice(0, split), name: split < 0 ? params.id : params.id.slice(split + 1) };
      } else if (path === "/run" && req.headers.get("content-type")?.includes("application/json")) {
        try { const body = parseExactJson(await req.clone().text()); if (typeof body?.filename === "string") context.target = { source: body.host, name: body.filename }; context.destination = body?.context?.origin?.source; } catch { /* The handler owns malformed body feedback. */ }
      }
      let response;
      try { response = await handler(req, params); }
      catch (error) { return Response.json({ error: error.message, problem: problemFrom(error, context) }, { status: error.status ?? 500 }); }
      if (!response.headers.get("content-type")?.includes("application/json")) return response;
      let body;
      try { body = parseExactJson(await response.clone().text()); } catch { return response; }
      if (!body?.error && !body?.errors?.length) return response;
      problemEnvelope(body, context);
      const headers = new Headers(response.headers); headers.delete("content-length");
      return new Response(stringifyExactJson(body), { status: response.status, headers });
    });
  } };
}
