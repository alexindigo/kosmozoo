import { createRoot, createSignal, createEffect, untrack } from "solid-js";
import * as api from "./api.js";
import { makeFaceModel } from "./model.mjs";
import { faceAt } from "./geometry.mjs";
import { makeFaceCamera } from "./camera.mjs";
import { faceCommands } from "./commands.js";
import { Controls, SettingsRow } from "./Controls.js";
import { FaceFeedback } from "./FaceFeedback.js";

export const bindings = [{ id: "wb.alignment", key: "a", ctx: "workbench", route: "workbench-pair",
  command: "workbench.alignment.cycle", desc: "comparator: cycle alignment" }];

export function install(store) {
  return createRoot(disposeRoot => {
    const [revision, setRevision] = createSignal(0), touch = () => setRevision(n => n + 1);
    const [settings, setSettings] = createSignal({ loaded: false, pending: false, url: null, draft: "", message: "" });
    const [readiness, setReadiness] = createSignal({ phase: "pending", model: null, message: "Checking detector service" });
    const model = makeFaceModel({ detect: async (resource, signal) => {
      const url = settings().url, label = readiness().model;
      const result = await api.detect(resource, signal);
      if (result.detector.serviceUrl !== url || result.detector.model !== label) throw new Error("Detector identity changed; retry detection");
      return result;
    }, changed: touch });
    let alive = true, loading = null, configGeneration = 0;
    let statusKey = null, statusController = null;
    const camera = makeFaceCamera();
    const context = store.comparison.context;
    const active = () => context().eligible && context().alignment === "face";
    const resources = () => context().resources;
    const recordFor = resource => { revision(); return model.record(resource); };
    const acceptedRecord = side => feedbackRecord(store.comparison.accepted()[side]);
    function feedbackRecord(accepted) {
      if (!active() || !accepted || accepted.session !== context().session) return null;
      if (!Object.values(resources()).some(resource => resource && resource.source === accepted.resource?.source && resource.stamp === accepted.resource?.stamp)) return null;
      revision();
      const record = model.record(accepted.resource, accepted.recordId);
      return record && record.id === accepted.recordId && record.image.hash === accepted.hash &&
        record.w === accepted.size?.w && record.h === accepted.size?.h ? record : null;
    }
    async function loadSettings() {
      if (loading || settings().loaded) return loading;
      setSettings(s => ({ ...s, pending: true, message: "Loading detector settings" }));
      loading = Promise.all([api.settings(), api.discovery()]).then(([values, plugins]) => {
        if (!alive) return;
        const installed = plugins.some(p => p.name === "detector" && !p.error);
        setSettings({ loaded: true, pending: false, url: values.serviceUrl ?? null, draft: values.serviceUrl ?? "",
          message: installed ? values.serviceUrl ? "Detector configured" : "Set a detector service URL" : "Detector plugin unavailable" });
      }, error => { if (alive) setSettings(s => ({ ...s, pending: false, message: String(error.message) })); })
        .finally(() => { loading = null; });
      return loading;
    }
    function probeStatus(force = false) {
      const c = context(), config = settings();
      if (!active() || !config.loaded || !config.url || config.pending) return;
      const key = `${c.session}:${configGeneration}:${config.url}`;
      if (!force && statusKey === key) return;
      statusController?.abort();
      const controller = statusController = new AbortController(); statusKey = key;
      setReadiness(s => ({ ...s, phase: "pending", message: "Checking detector service" }));
      return api.status(controller.signal).then(result => {
        if (!alive || controller !== statusController || controller.signal.aborted) return;
        const ready = result.state === "ready";
        setReadiness({ phase: ready ? "ready" : result.state === "loading" ? "loading" : "error", model: result.model ?? null,
          message: ready ? "Detector ready" : result.state === "loading" ? "Detector model is loading" : "Detector service unavailable", retry: !ready });
      }, error => {
        if (alive && controller === statusController && !controller.signal.aborted)
          setReadiness(s => ({ ...s, phase: "error", message: String(error.message), retry: true }));
      });
    }
    createEffect(() => {
      if (store.state.menuOpen() || active()) untrack(loadSettings);
    });
    createEffect(() => {
      const c = context(), config = settings();
      c.session; config.url; config.loaded; config.pending;
      untrack(probeStatus);
    });
    createEffect(() => {
      const c = context(), config = settings(), service = readiness();
      const token = `${c.session}:${configGeneration}:${config.url ?? ""}:${service.model ?? ""}`;
      const allowWork = !!(active() && config.loaded && config.url && !config.pending && service.phase === "ready");
      const retained = Object.values(store.comparison.accepted()).filter(side => side?.recordId)
        .map(side => ({ resource: side.resource, recordId: side.recordId }));
      untrack(() => model.update(token, Object.values(c.resources), retained, allowWork));
    });
    const choose = ({ side, record, face }) => {
      const accepted = store.comparison.accepted()[side], current = feedbackRecord(accepted);
      return !!current && current.id === record && model.choose(accepted.resource, record, face);
    };
    const status = () => {
      revision();
      if (!settings().loaded || settings().pending) return { phase: settings().pending ? "pending" : "error", message: settings().message, retry: !settings().pending };
      if (!settings().url) return { phase: "error", message: settings().message };
      if (readiness().phase !== "ready") return readiness();
      const states = Object.values(resources()).map(resource => model.state(resource));
      const state = states.find(s => s.phase === "choice-error") ?? states.find(s => s.phase === "error") ??
        states.find(s => s.phase !== "ready") ?? { phase: "ready", message: "Faces registered" };
      if (Object.values(store.comparison.accepted()).some(side => side?.replacementFailure))
        return { phase: "decode-error", message: "Image decode failed; showing the previous image" };
      if (state.phase === "ready" && (!acceptedRecord("a") || !acceptedRecord("b"))) return { phase: "pending", message: "Decoding detected image content" };
      return state;
    };
    const comparison = {
      resource(side, resource) {
        const record = active() && recordFor(resource);
        return record ? { ...resource, resource: { ...resource, hash: record.image.hash }, src: resource.source === "anchor" ? resource.src : `/api/content/${record.image.hash}/bytes`,
          hash: record.image.hash, recordId: record.id } : { ...resource, resource, hash: undefined };
      },
      resolve(ordinary) {
        revision();
        if (!active()) return ordinary;
        const a = acceptedRecord("a"), b = acceptedRecord("b");
        const eyesA = a?.faces.find(f => f.id === a.anchor)?.eyes, eyesB = b?.faces.find(f => f.id === b.anchor)?.eyes;
        if (!eyesA || !eyesB || !ordinary.a || !ordinary.b) return ordinary;
        return camera.resolve(ordinary, { session: context().session, reference: b, eyesA, eyesB });
      },
      gesture(side, mapping, frame = () => "") {
        if (!active() || !acceptedRecord("a")?.anchor || !acceptedRecord("b")?.anchor || !mapping) return null;
        const ticket = () => active() ? JSON.stringify([context().session, configGeneration, frame(),
          ["a", "b"].map(side => { const r = acceptedRecord(side); return [r?.id, r?.anchor]; })]) : null;
        return camera.gesture(mapping, ticket, touch);
      },
      activate(side, mapping, point) {
        const record = acceptedRecord(side), face = faceAt(record, mapping, point);
        return face ? store.handles.invoke("faces.use", { side, record: record.id, face: face.id }) : false;
      },
    };
    return {
      alignmentModes: ["face"], alignmentOptions: [{ value: "face", label: "Face-anchored", available: () => context().eligible }],
      comparison, settingsRow: SettingsRow, workbenchControls: Controls, workbenchFeedback: FaceFeedback,
      commands: faceCommands({ choose, retry: async () => {
        if (!settings().loaded) return loadSettings();
        await probeStatus(true); if (readiness().phase === "ready") model.retry();
      },
        edit: value => setSettings(s => ({ ...s, draft: value, message: "" })),
        async save() {
          const value = settings().draft.trim();
          if (value) {
            try { const url = new URL(value); if (!["http:", "https:"].includes(url.protocol)) throw new Error(); }
            catch { setSettings(s => ({ ...s, message: "Use an http or https service URL" })); return false; }
          }
          setSettings(s => ({ ...s, pending: true, message: "Saving detector settings" }));
          try {
            await api.saveSettings(value || null); const confirmed = await api.settings();
            if (!alive) return false;
            configGeneration++; camera.reset(); statusKey = null; statusController?.abort();
            setSettings({ loaded: true, pending: false, url: confirmed.serviceUrl ?? null, draft: confirmed.serviceUrl ?? "", message: "Detector settings saved" });
            return true;
          } catch (error) { if (alive) setSettings(s => ({ ...s, pending: false, message: String(error.message) })); return false; }
        },
        cycle() {
          if (!context().open || !store.state.diffPresentation().comparison) return false;
          const modes = store.state.comparisonAlignments().map(option => option.value);
          return store.handles.invoke("workbench.alignment", { mode: modes[(modes.indexOf(context().alignment) + 1) % modes.length] });
        },
      }),
      ports: { settings, status, acceptedRecord, feedbackRecord, eligible: () => context().eligible,
        alignment: () => context().alignment, bindings: store.state.bindings },
      dispose() { alive = false; statusController?.abort(); model.dispose(); disposeRoot(); },
    };
  });
}
