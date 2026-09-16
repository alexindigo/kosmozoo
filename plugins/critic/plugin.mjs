// plugins/critic/plugin.mjs — image critic (OPTIONAL, additive; nothing
// depends on it). A vision service serving the other half of the north star:
// detailed feedback on what's wrong/right — semantics, not geometry.
//
// Same shape as the detector: thin client to an external service, config'd
// URL, degrades to absent. The service is any OpenAI-compatible vision
// endpoint (or a local VLM).

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

  // one proxy per POST route: bytes in, JSON out; r.ok checked; the shared
  // reason helper answers the same {error, reason} shape as the detector
  const proxyTo = (path) => async (req) => {
    if (!url()) return kz.reason(503, "service unconfigured", "unconfigured");
    const body = await req.arrayBuffer();
    let r;
    try {
      r = await fetch(`${url()}${path}`, {
        method: "POST", body, signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      return kz.reason(503, "service unreachable", String(e?.message ?? e));
    }
    if (!r.ok) return kz.reason(502, "service error", `status ${r.status}`);
    const data = await r.json().catch(() => null);
    if (!data) return kz.reason(502, "service error", "no JSON in response");
    return Response.json(data);
  };

  kz.route("POST", "/describe", proxyTo("/describe"));
  kz.route("POST", "/diff-describe", proxyTo("/diff"));
  kz.route("POST", "/caption", proxyTo("/caption"));
}
