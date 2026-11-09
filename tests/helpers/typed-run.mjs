import { register } from "../../src/features/variations/server.mjs";
import { enqueue } from "../../src/backings/comfy.mjs";
import { makeCollectionLifecycle } from "../../src/backings/index.mjs";
import { parseExactJson, stringifyExactJson } from "../../src/parameters.mjs";

export function typedRunRig({ graph, schema = {}, acceptance = "confirmed", filename = "source_00001_.png" }) {
  const routes = new Map(), bytes = [], hosts = { fake: "fixture:8188" }, lifecycle = makeCollectionLifecycle(hosts);
  const backing = { objectInfo: async () => ({ outputClasses: new Set(["SaveImage"]), ...schema }), enqueue: job => enqueue("fixture:8188", job, {
    fetcher: (_url, init) => {
      bytes.push(init.body);
      return Promise.resolve(new Response(JSON.stringify(acceptance === "uncertain" ? {} : {
        prompt_id: `typed-${bytes.length}`, node_errors: acceptance === "partial" ? { save: { errors: ["fixture"] } } : {},
      }), { headers: { "Content-Type": "application/json" } }));
    },
  }) };
  register({ hosts, route: (method, path, fn) => routes.set(method + path, fn),
    store: { hashFor: () => "a".repeat(64) }, ingest: { graph: async () => structuredClone(graph) },
    backings: { capture: lifecycle.capture, isCurrent: lifecycle.isCurrent, comfy: () => backing, accepting: () => true,
      source: id => { const token = lifecycle.capture(id); return { address: token.address, kind: "comfy", incarnation: token.incarnation,
        sourceVersion: { epoch: "fixture-epoch", incarnation: token.incarnation } }; } } });
  const probe = async () => parseExactJson(await (await routes.get("GET/probe/<id>")(new Request("http://fixture/probe"), { id: `fake:${filename}` })).text());
  return { bytes, probe, async request(imageParams, ranges = {}) { return { id: `fake:${filename}`, host: "fake", filename,
    ranges, imageParams, prefix: "manual_", suffix: "", context: (await probe()).context,
    acknowledgement: { version: 2, runId: crypto.randomUUID(), requestId: crypto.randomUUID() } }; },
    async run(body) { const response = await routes.get("POST/run")(new Request("http://fixture/run", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: stringifyExactJson(body) }));
      return { status: response.status, data: parseExactJson(await response.text()) }; } };
}
