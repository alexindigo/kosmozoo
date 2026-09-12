// plugins/detector/plugin.mjs — face/landmark detector, thin client to an
// external service. The architecturally important plugin: it brings its own
// external dependency and degrades to ABSENT, never broken.
//
// The contract (not the implementation) is what's specified: a detector
// plugin contributes one thing — the `face-anchored` value on the alignment
// axis. To do that it must return, per image, a box plus enough keypoints to
// derive **eye midpoint** and **inter-eye distance** — the two numbers the
// alignment transform consumes. Everything else is plugin-private.

export function register(kz) {
  const serviceUrl = () => kz.settings.get("serviceUrl", null);

  // ONE deadline: the service's /health exposes it (its worker deadline),
  // the plugin honors it with a margin. Refreshed lazily on first detect and
  // on every /status; the default only covers the unconfigured window.
  let deadlineMs = null;
  const deadline = async () => {
    if (deadlineMs) return deadlineMs;
    const url = serviceUrl();
    if (!url) return 65_000;
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
      const h = await r.json();
      if (typeof h.deadline_ms === "number") deadlineMs = h.deadline_ms + 5000;
    } catch { /* unreachable — the default stands */ }
    return deadlineMs ?? 65_000;
  };

  kz.alignment("face-anchored", {
    label: "Face-anchored",
    // needs.ok is a FUNCTION — evaluated per /api/plugins request, never
    // frozen at register (the user can configure the service at runtime)
    needs: [
      { kind: "config", key: "serviceUrl",
        ok: () => !!serviceUrl(),
        reason: "no detector service configured (plugins.detector.serviceUrl)" },
    ],
    // The eye anchors the transform needs. 28-point model: eyes are groups
    // 11–16 (left) and 17–22 (right). eye midpoint + inter-eye distance.
    derives: ["eyeMidpoint", "interEyeDistance"],
  });

  // per-image detection: the caller names a collection+name — the engine
  // reads the bytes from the CACHE (no browser round-trip). A raw
  // octet-stream body still works for local anchor blobs.
  kz.route("POST", "/detect", async (req) => {
    const url = serviceUrl();
    if (!url) {
      return Response.json({ error: "service unreachable", reason: "unconfigured" }, { status: 503 });
    }
    let body;
    if ((req.headers.get("Content-Type") ?? "").includes("application/json")) {
      const { collection, name } = await req.json().catch(() => ({}));
      const bytes = collection && name ? await kz.content.bytesForEntry(collection, name) : null;
      if (!bytes) {
        return Response.json({ error: "image not cached", reason: "ingest it first" }, { status: 404 });
      }
      body = bytes;
    } else {
      body = await req.arrayBuffer();
    }
    let res;
    try {
      res = await fetch(`${url}/detect`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body,
        signal: AbortSignal.timeout(await deadline()),
      });
    } catch (e) {
      // absent, not broken: surface the failure state as a reason
      return Response.json({ error: "service unreachable", reason: String(e?.message ?? e) }, { status: 503 });
    }
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      return Response.json(
        { error: "service error", reason: d.reason ?? `status ${res.status}` },
        { status: 502 },
      );
    }
    const data = await res.json();
    return Response.json(data); // { w, h, faces: [{bbox, score, kps}] }
  });

  kz.route("GET", "/status", async () => {
    const url = serviceUrl();
    if (!url) return Response.json({ state: "unconfigured" });
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
      const h = await r.json();
      if (typeof h.deadline_ms === "number") deadlineMs = h.deadline_ms + 5000;
      // model_ready is the honest readiness bit (worker alive AND the
      // handshake consumed); "loading" was a lie the old service told
      return Response.json({
        state: h.model_ready ? "ready" : "loading",
        model: h.model, stderr: h.stderr_tail, deadlineMs: h.deadline_ms,
      });
    } catch {
      return Response.json({ state: "unreachable" });
    }
  });
}
