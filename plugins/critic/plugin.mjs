// plugins/critic/plugin.mjs — image critic (OPTIONAL, additive; nothing
// depends on it). A vision service serving the other half of the north star:
// detailed feedback on what's wrong/right — semantics, not geometry.
//
// Same shape as the detector: thin client to an external service, config'd
// URL, degrades to absent. The service is any OpenAI-compatible vision
// endpoint (or a local VLM). What kosmozoo gets: defect descriptions you edit
// rather than type, candidate-vs-anchor difference descriptions, pre-tagged
// recurring defect categories, and draft caption .txt for training export.

export function register(kz) {
  const url = () => kz.settings.get("serviceUrl", null);

  kz.route("GET", "/status", async () => {
    if (!url()) return Response.json({ state: "unconfigured" });
    try {
      const r = await fetch(`${url()}/health`, { signal: AbortSignal.timeout(5000) });
      return Response.json({ state: r.ok ? "ready" : "loading" });
    } catch {
      return Response.json({ state: "unreachable" });
    }
  });

  // describe what's wrong with an image
  kz.route("POST", "/describe", async (req) => {
    if (!url()) return Response.json({ error: "unconfigured" }, { status: 503 });
    const body = await req.arrayBuffer();
    const r = await fetch(`${url()}/describe`, {
      method: "POST", body, signal: AbortSignal.timeout(120_000),
    }).catch(() => null);
    if (!r) return Response.json({ error: "unreachable" }, { status: 503 });
    return Response.json(await r.json());
  });

  // compare candidate against anchor; describe the difference
  kz.route("POST", "/diff-describe", async (req) => {
    if (!url()) return Response.json({ error: "unconfigured" }, { status: 503 });
    const body = await req.arrayBuffer(); // two images packed by the caller
    const r = await fetch(`${url()}/diff`, {
      method: "POST", body, signal: AbortSignal.timeout(120_000),
    }).catch(() => null);
    if (!r) return Response.json({ error: "unreachable" }, { status: 503 });
    return Response.json(await r.json());
  });

  // draft a caption .txt for the export plugin
  kz.route("POST", "/caption", async (req) => {
    if (!url()) return Response.json({ error: "unconfigured" }, { status: 503 });
    const body = await req.arrayBuffer();
    const r = await fetch(`${url()}/caption`, {
      method: "POST", body, signal: AbortSignal.timeout(120_000),
    }).catch(() => null);
    if (!r) return Response.json({ error: "unreachable" }, { status: 503 });
    const { caption } = await r.json();
    return Response.json({ caption });
  });
}
