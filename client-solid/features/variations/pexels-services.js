// The one client owner of configured Pexels services. Settings and the
// Variations picker read the same redacted list; keys are write-only here.

const errorText = error => error?.detail || error?.message || String(error);

export function makePexelsServices({ api, changed = () => {} }) {
  let state = Object.freeze({ loaded: false, pending: false, error: "", services: Object.freeze([]) });
  let alive = true, loading = null, generation = 0;
  const publish = patch => { state = Object.freeze({ ...state, ...patch }); if (alive) changed(); };
  const valid = list => Array.isArray(list) && list.every(item => item && typeof item.id === "string" && typeof item.name === "string" &&
    typeof item.url === "string" && typeof item.hasKey === "boolean");

  const load = (force = false) => {
    if (!alive) return Promise.resolve();
    if (loading) return loading;
    if (state.loaded && !force) return Promise.resolve();
    const captured = ++generation;
    publish({ pending: true, error: "" });
    loading = api.pexelsServices().then(result => {
      if (!alive || captured !== generation) return;
      if (!valid(result?.services)) throw new Error("The engine sent an unreadable service list");
      publish({ loaded: true, pending: false, error: "", services: Object.freeze(result.services.map(item => Object.freeze({ ...item }))) });
    }).catch(error => { if (alive && captured === generation) publish({ pending: false, error: errorText(error) }); })
      .finally(() => { if (captured === generation) loading = null; });
    return loading;
  };

  // Mutations confirm by re-reading the engine list; the caller receives the
  // saved service or a readable error message.
  const mutate = async (action, onSaved = () => {}) => {
    let saved;
    try { saved = await action(); }
    catch (error) { return { ok: false, error: errorText(error) }; }
    generation++; loading = null; onSaved(saved);
    await load(true);
    return { ok: true, service: saved };
  };

  return {
    state: () => state,
    load,
    create: details => mutate(() => api.createPexelsService(details)),
    update: (id, details, onSaved) => mutate(() => api.updatePexelsService(id, details), onSaved),
    remove: (id, onSaved) => mutate(() => api.removePexelsService(id), onSaved),
    dispose() { alive = false; generation++; },
  };
}
