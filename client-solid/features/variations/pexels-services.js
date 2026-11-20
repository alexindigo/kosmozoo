// The one client owner of configured Pexels services. Settings and the
// Variations picker read the same redacted list; keys are write-only here.

import { variationProblem, problemFrom, problemText } from "/shared/features/variations/problems.mjs";
const errorText = error => error?.detail || error?.message || String(error);
const sentence = text => String(text).replace(/[.\s]+$/, "");

export function makePexelsServices({ api, changed = () => {} }) {
  let state = Object.freeze({ loaded: false, pending: false, error: "", problem: null, services: Object.freeze([]) });
  const nameOf = id => state.services.find(item => item.id === id)?.name ?? id;
  let alive = true, loading = null, generation = 0;
  // Per-service connection check: the engine runs a real first-page query.
  const checks = new Map();
  const check = id => {
    if (!alive) return;
    checks.get(id)?.controller.abort();
    const controller = new AbortController(), entry = { controller, phase: "checking", message: "" };
    checks.set(id, entry); if (alive) changed();
    const source = nameOf(id);
    api.pexelsStatus(id, controller.signal).then(result => {
      if (checks.get(id) !== entry) return;
      if (typeof result?.ok !== "boolean") throw new Error("the engine sent an unreadable status");
      Object.assign(entry, result.ok ? { phase: "ok", message: "" } : { phase: "error",
        message: result.problem ? problemText(problemFrom({ problem: result.problem }, { source })) : String(result.error ?? "Query failed") });
    }).catch(error => { if (checks.get(id) === entry && !controller.signal.aborted) Object.assign(entry, { phase: "error", message: problemText(problemFrom(error, { code: "pexels-status", phase: "pexels", source })) }); })
      .finally(() => { if (alive && checks.get(id) === entry) changed(); });
  };
  const retire = () => {
    const ids = new Set(state.services.map(item => item.id));
    for (const [id, entry] of checks) if (!ids.has(id)) { entry.controller.abort(); checks.delete(id); }
  };
  const publish = patch => { state = Object.freeze({ ...state, ...patch }); if (alive) changed(); };
  const valid = list => Array.isArray(list) && list.every(item => item && typeof item.id === "string" && typeof item.name === "string" &&
    typeof item.url === "string" && typeof item.hasKey === "boolean");

  const load = (force = false) => {
    if (!alive) return Promise.resolve();
    if (loading) return loading;
    if (state.loaded && !force) return Promise.resolve();
    const captured = ++generation;
    publish({ pending: true, error: "", problem: null });
    loading = api.pexelsServices().then(result => {
      if (!alive || captured !== generation) return;
      if (!valid(result?.services)) throw new Error("The engine sent an unreadable service list");
      publish({ loaded: true, pending: false, error: "", problem: null, services: Object.freeze(result.services.map(item => Object.freeze({ ...item }))) });
      retire();
    }).catch(error => {
      if (!alive || captured !== generation) return;
      // The structured cause (e.g. an unreadable engine file) is kept; `error`
      // stays its bare cause for the Variations acquisition summary.
      const problem = problemFrom(error, { code: "pexels-list", phase: "pexels" });
      publish({ pending: false, error: error?.problem ? sentence(problem.message) : errorText(error), problem });
    })
      .finally(() => { if (captured === generation) loading = null; });
    return loading;
  };

  // Mutations confirm by re-reading the engine list; the caller receives the
  // saved service or a readable error message.
  const mutate = async (action, onSaved = () => {}, { verb, label } = {}) => {
    let saved;
    try { saved = await action(); }
    catch (error) { return { ok: false, error: error?.problem ? problemText(problemFrom(error, { source: label })) : errorText(error) }; }
    generation++; loading = null; onSaved(saved);
    await load(true);
    if (saved?.id && state.services.some(item => item.id === saved.id)) check(saved.id);
    // The mutation succeeded; only the confirming read failed. Never ask to repeat it.
    const reloadProblem = state.error ? variationProblem("pexels-reload", { phase: "pexels", source: saved?.name ?? label, operation: verb, detail: state.error }) : null;
    return { ok: true, service: saved, ...(reloadProblem ? { reloadProblem } : {}) };
  };

  return {
    state: () => state,
    load,
    status: id => { const entry = checks.get(id); return entry ? { phase: entry.phase, message: entry.message } : { phase: "unknown", message: "" }; },
    // Settings opening re-checks every service; one in flight is replaced.
    checkAll: () => load(true).then(() => { for (const item of state.services) check(item.id); }),
    recheck: id => check(id),
    create: details => mutate(() => api.createPexelsService(details), undefined, { verb: "saved", label: details?.name }),
    update: (id, details, onSaved) => mutate(() => api.updatePexelsService(id, details), onSaved, { verb: "saved", label: details?.name ?? nameOf(id) }),
    remove: (id, onSaved) => mutate(() => api.removePexelsService(id), onSaved, { verb: "removed", label: nameOf(id) }),
    dispose() { alive = false; generation++; for (const entry of checks.values()) entry.controller.abort(); checks.clear(); },
  };
}
