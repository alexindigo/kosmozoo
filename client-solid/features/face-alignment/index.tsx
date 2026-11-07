import { createRoot, createSignal, createEffect, untrack } from "solid-js";
import * as api from "./api.js";
import { makeFaceModel } from "./model.mjs";
import { faceAt } from "./geometry.mjs";
import { makeFaceCamera } from "./camera.mjs";
import { facePresentation } from "./presentation.mjs";
import { faceCommands } from "./commands.js";
import { Controls, SettingsRow } from "./Controls.js";
import { FaceFeedback } from "./FaceFeedback.js";

export const bindings = [{ id: "wb.alignment", key: "a", ctx: "workbench", route: "workbench-pair",
  command: "workbench.alignment.cycle", desc: "comparator: cycle alignment" }];

export function install(store) {
  return createRoot(disposeRoot => {
    const [revision, setRevision] = createSignal(0), touch = () => setRevision(n => n + 1);
    const [enabled, setEnabled] = createSignal(false);
    const [settings, setSettings] = createSignal({ loaded: false, pending: false, url: null, draft: "", message: "" });
    const [readiness, setReadiness] = createSignal({ phase: "pending", model: null, message: "Checking detector service" });
    const model = makeFaceModel({ detect: async (resource, signal) => {
      const url = settings().url, label = readiness().model;
      const result = await api.detect(resource, signal);
      if (result.detector.serviceUrl !== url || result.detector.model !== label) throw new Error("Detector identity changed; retry detection");
      return result;
    }, changed: touch });
    let alive = true, loading = null, configGeneration = 0;
    let statusKey = null, statusController = null, activationEpoch = 0;
    const camera = makeFaceCamera();
    const context = store.comparison.context;
    const detectionActive = () => enabled() && context().eligible;
    const registrationActive = () => detectionActive() && context().alignment === "face";
    function suspend() {
      activationEpoch++; statusController?.abort(); statusController = null; statusKey = null;
      model.suspend();
      // Keep observed model identity throughout readiness revalidation. A toggle
      // retires admission, not immutable results or the user's chosen anchors.
      setReadiness(s => ({ ...s, phase: "pending", message: "Checking detector service" }));
    }
    const toggleDetection = () => {
      if (!context().eligible) return false;
      suspend(); setEnabled(value => !value); return true;
    };
    const resources = () => context().resources;
    const recordFor = resource => { revision(); return model.record(resource); };
    const acceptedRecord = side => feedbackRecord(store.comparison.accepted()[side]);
    function feedbackRecord(accepted) {
      if (!detectionActive() || !accepted || accepted.session !== context().session) return null;
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
      if (!alive || !detectionActive() || !config.loaded || !config.url || config.pending) return;
      const epoch = activationEpoch, key = `${c.session}:${configGeneration}:${config.url}:${epoch}`;
      if (!force && statusKey === key) return;
      statusController?.abort();
      const controller = statusController = new AbortController(); statusKey = key;
      setReadiness(s => ({ ...s, phase: "pending", message: "Checking detector service" }));
      return api.status(controller.signal).then(result => {
        if (!alive || !detectionActive() || epoch !== activationEpoch || controller !== statusController || controller.signal.aborted) return;
        const ready = result.state === "ready";
        setReadiness(previous => ({ phase: ready ? "ready" : result.state === "loading" ? "loading" : "error",
          model: ready || Object.hasOwn(result, "model") ? result.model ?? null : previous.model,
          message: ready ? "Detector ready" : result.state === "loading" ? "Detector model is loading" : "Detector service unavailable", retry: !ready }));
      }, error => {
        if (alive && detectionActive() && epoch === activationEpoch && controller === statusController && !controller.signal.aborted)
          setReadiness(s => ({ ...s, phase: "error", message: String(error.message), retry: true }));
      });
    }
    createEffect(() => {
      if (store.state.menuOpen() || detectionActive()) untrack(loadSettings);
    });
    createEffect(() => {
      const c = context(), config = settings();
      const active = detectionActive();
      c.session; config.url; config.loaded; config.pending;
      if (!active || config.pending) { untrack(suspend); return; }
      untrack(probeStatus);
    });
    createEffect(() => {
      const c = context(), config = settings(), service = readiness();
      const token = `${c.session}:${configGeneration}:${config.url ?? ""}:${service.model ?? ""}`;
      const allowChoice = !!(detectionActive() && config.loaded && config.url && !config.pending);
      const allowWork = allowChoice && service.phase === "ready";
      const retained = Object.values(store.comparison.accepted()).filter(side => side?.recordId)
        .map(side => ({ resource: side.resource, recordId: side.recordId }));
      untrack(() => model.update(token, Object.values(c.resources), retained, allowWork, allowChoice));
    });
    const choose = ({ side, record, face }) => {
      const accepted = store.comparison.accepted()[side], current = feedbackRecord(accepted);
      if (!current || current.id !== record || !model.choose(accepted.resource, record, face)) return false;
      return store.handles.invoke("workbench.alignment", { mode: "face" });
    };
    const status = () => {
      revision();
      if (!settings().loaded || settings().pending) return { phase: settings().pending ? "pending" : "error", message: settings().message, retry: !settings().pending };
      if (!settings().url) return { phase: "error", message: settings().message };
      if (readiness().phase !== "ready") return readiness();
      const states = Object.values(resources()).map(resource => model.state(resource));
      const state = states.find(s => s.phase === "choice-error") ?? states.find(s => s.phase === "error") ??
        states.find(s => s.phase !== "ready") ?? { phase: "ready", message: registrationActive() ? "Faces registered" : "Faces detected" };
      if (Object.values(store.comparison.accepted()).some(side => side?.replacementFailure))
        return { phase: "decode-error", message: "Image decode failed; showing the previous image" };
      if (state.phase === "ready" && (!acceptedRecord("a") || !acceptedRecord("b"))) return { phase: "pending", message: "Decoding detected image content" };
      return state;
    };
    const comparison = {
      resource(side, resource) {
        const record = detectionActive() && recordFor(resource);
        return facePresentation(resource, record, detectionActive());
      },
      resolve(ordinary) {
        revision();
        if (!registrationActive()) return ordinary;
        const a = acceptedRecord("a"), b = acceptedRecord("b");
        const eyesA = a?.faces.find(f => f.id === a.anchor)?.eyes, eyesB = b?.faces.find(f => f.id === b.anchor)?.eyes;
        if (!eyesA || !eyesB || !ordinary.a || !ordinary.b) return ordinary;
        return camera.resolve(ordinary, { session: context().session, reference: b, eyesA, eyesB });
      },
      gesture(side, mapping, frame = () => "") {
        if (!registrationActive() || !acceptedRecord("a")?.anchor || !acceptedRecord("b")?.anchor || !mapping) return null;
        const ticket = () => registrationActive() ? JSON.stringify([context().session, configGeneration, activationEpoch, frame(),
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
      commands: faceCommands({ choose, toggleDetection, retry: async () => {
        if (!alive || !detectionActive()) return false;
        const epoch = activationEpoch;
        if (!settings().loaded) await loadSettings();
        if (!alive || !detectionActive() || epoch !== activationEpoch) return false;
        await probeStatus(true);
        if (!alive || !detectionActive() || epoch !== activationEpoch) return false;
        if (readiness().phase === "ready") model.retry();
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
      ports: { settings, status, enabled, acceptedRecord, feedbackRecord, eligible: () => context().eligible,
        alignment: () => context().alignment, bindings: store.state.bindings },
      dispose() { alive = false; statusController?.abort(); model.dispose(); disposeRoot(); },
    };
  });
}
