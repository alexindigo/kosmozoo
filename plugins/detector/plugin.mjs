// plugins/detector/plugin.mjs — face/landmark detector, thin client to an
// external service. The architecturally important plugin: it brings its own
// external dependency and degrades to ABSENT, never broken.
//
// The contract (not the implementation) is what's specified: a detector
// plugin contributes one thing — the `face-anchored` value on the alignment
// axis. To do that it must return, per image, a box plus enough keypoints to
// derive **eye midpoint** and **inter-eye distance** — the two numbers the
// alignment transform consumes. Everything else is plugin-private.
//
// Reference flavour: thin client against an external service (the only one
// with a measured track record — 92% on 60 images via anime-face-detector).
// The service URL is plugin config; absent/unconfigured => the face-anchored
// alignment value is simply absent from the axis, with a reason.

export function register(kz) {
  const SERVICE_URL = kz.settings.get("serviceUrl", null);

  kz.alignment("face-anchored", {
    label: "Face-anchored",
    // Declared needs drive availability AND the reason surfaced when unmet.
    needs: [
      { kind: "config", key: "serviceUrl", ok: !!SERVICE_URL,
        reason: "no detector service configured (plugins.detector.serviceUrl)" },
    ],
    // The eye anchors the transform needs. 28-point model: eyes are groups
    // 11–16 (left) and 17–22 (right). eye midpoint + inter-eye distance.
    derives: ["eyeMidpoint", "interEyeDistance"],
  });

  // per-image detection: engine fetches the bytes (host proxy or a local
  // anchor blob forwarded by the client), posts them to the service.
  kz.route("POST", "/detect", async (req) => {
    const url = kz.settings.get("serviceUrl", null);
    if (!url) {
      return Response.json({ error: "service unreachable", reason: "unconfigured" }, { status: 503 });
    }
    const body = await req.arrayBuffer();
    let res;
    try {
      res = await fetch(`${url}/detect`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body,
        signal: AbortSignal.timeout(70_000), // outlives the worker deadline
      });
    } catch (e) {
      // absent, not broken: surface the failure state as a reason
      return Response.json({ error: "service unreachable", reason: String(e?.message ?? e) }, { status: 503 });
    }
    if (!res.ok) {
      return Response.json({ error: "service error", reason: `status ${res.status}` }, { status: 502 });
    }
    const data = await res.json();
    return Response.json(data); // { w, h, faces: [{bbox, score, kps}] }
  });

  kz.route("GET", "/status", async () => {
    const url = kz.settings.get("serviceUrl", null);
    if (!url) return Response.json({ state: "unconfigured" });
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
      const h = await r.json();
      return Response.json({ state: h.ready ? "ready" : "loading", model: h.model, stderr: h.stderr_tail });
    } catch {
      return Response.json({ state: "unreachable" });
    }
  });
}
