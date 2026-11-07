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
  // on every /status. No hand-synced default: no deadline from /health means
  // unconfigured — /detect refuses rather than guessing a timeout.
  let configuration = null;
  const capture = () => {
    const url = serviceUrl();
    if (!configuration || configuration.url !== url) configuration = { url, health: null, probe: null };
    return configuration;
  };
  const current = config => capture() === config;
  const validDeadline = h => Number.isFinite(h?.deadline_ms) && h.deadline_ms > 0 &&
    h.deadline_ms + 5000 <= 0xffffffff;
  const probe = async config => {
    try {
      const r = await fetch(`${config.url}/health`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) return null;
      const h = await r.json();
      return validDeadline(h) ? h : null;
    } catch { return null; }
  };
  const health = async (config, refresh = false) => {
    if (!config.url) return null;
    if (!refresh && config.health) return config.health;
    if (!config.probe) config.probe = probe(config).then(h => {
      if (current(config)) config.health = h;
      return h;
    }).finally(() => { config.probe = null; });
    return config.probe;
  };
  const changed = () => Response.json({ error: "detector configuration changed", reason: "retry with the current service" }, { status: 409 });

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
  // reads through the typed Ingest/cache port (no browser round-trip). A raw
  // octet-stream body still works for local anchor blobs.
  kz.route("POST", "/detect", async (req) => {
    const config = capture();
    let body, image;
    if ((req.headers.get("Content-Type") ?? "").includes("application/json")) {
      const value = await req.json().catch(() => null);
      if (!value || Array.isArray(value) || typeof value.collection !== "string" || !value.collection ||
          typeof value.name !== "string" || !value.name ||
          (Object.hasOwn(value, "kind") && !["input", "output"].includes(value.kind)) ||
          (Object.hasOwn(value, "expectedHash") && !kz.content.isHash(value.expectedHash))) {
        return Response.json({ error: "invalid image address", reason: "collection, name, kind or expectedHash is invalid" }, { status: 400 });
      }
      const { collection, name, kind = "output", expectedHash } = value;
      const record = await kz.content.imageForEntry(collection, name, kind);
      if (record.status !== 200 || !record.bytes) {
        return Response.json({ error: "image unavailable", reason: record.cancelled ? "source retired" : `content status ${record.status}` },
          { status: record.cancelled ? 409 : record.status === 400 ? 400 : record.status === 404 ? 404 : 502 });
      }
      if (expectedHash && expectedHash !== record.hash) {
        return Response.json({ error: "image changed", reason: "expectedHash does not match accepted content" }, { status: 409 });
      }
      body = record.bytes;
      image = { collection, name, kind, hash: record.hash };
    } else {
      body = await req.arrayBuffer();
      image = { hash: await kz.content.hash(body) };
    }
    if (!current(config)) return changed();
    const h = await health(config);
    if (!current(config)) return changed();
    if (!h) {
      return Response.json(
        { error: "service unreachable", reason: "unconfigured (no deadline from /health)" },
        { status: 503 },
      );
    }
    let res;
    try {
      res = await fetch(`${config.url}/detect`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body,
        signal: AbortSignal.timeout(Math.ceil(h.deadline_ms + 5000)),
      });
    } catch (e) {
      if (!current(config)) return changed();
      // absent, not broken: surface the failure state as a reason
      return Response.json({ error: "service unreachable", reason: String(e?.message ?? e) }, { status: 503 });
    }
    if (!current(config)) { await res.body?.cancel(); return changed(); }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (!current(config)) return changed();
      return Response.json(
        { error: "service error", reason: String(data?.reason ?? data?.error ?? `status ${res.status}`) },
        { status: 502 },
      );
    }
    try {
      const data = kz.results.detection(await res.json());
      if (!current(config)) return changed();
      return Response.json({ ...data, image, detector: { serviceUrl: config.url, model: typeof h.model === "string" ? h.model : null } });
    } catch (e) {
      if (!current(config)) return changed();
      return Response.json({ error: "service error", reason: String(e?.message ?? e) }, { status: 502 });
    }
  });

  kz.route("GET", "/status", async () => {
    const config = capture();
    if (!config.url) return Response.json({ state: "unconfigured" });
    const h = await health(config, true);
    if (!current(config)) return changed();
    if (!h) return Response.json({ state: "unreachable" });
    // Readiness reflects the worker handshake, not configuration alone.
    return Response.json({
      state: h.model_ready ? "ready" : "loading",
      model: h.model, stderr: h.stderr_tail, deadlineMs: h.deadline_ms,
    });
  });
}
