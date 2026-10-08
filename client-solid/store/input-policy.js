// Transport acceptance is independent of an action's result (including false).
export function makeInputPolicy({ handles, state, layers, captureEvent, onError }) {
  const consumed = new WeakSet();
  const observed = new WeakSet();
  const observe = (result) => {
    if (result && typeof result.then === "function" && !observed.has(result)) {
      observed.add(result);
      result.then(undefined, onError);
    }
  };
  const invoke = (command, args) => {
    try { observe(handles.invoke(command, args)); } catch (error) { onError(error); }
  };
  const accepts = (binding) => {
    const wb = state.diff.open && !state.keysPanelOpen();
    if (binding.route === "keys") return state.keysPanelOpen() && !state.capturing();
    if (binding.route === "workbench") return wb;
    if (binding.route === "workbench-pair") return wb && !!state.diffPair().b;
    return true;
  };
  const request = (binding) => {
    if (!accepts(binding)) return false;
    invoke(binding.command, binding.args);
    return true;
  };
  const consume = (event, stop = true) => {
    consumed.add(event);
    event.preventDefault();
    if (stop) event.stopPropagation();
    return true;
  };
  return {
    request, invoke, observe,
    dispatch(event, keymap, phase = "bubble") {
      if (consumed.has(event)) return true;
      const active = layers();
      if (phase === "capture") {
        if (event.key !== "Escape" || active.some((layer) => layer.blocking)) return false;
        const popup = active.findLast((layer) => layer.phase === "capture");
        if (!popup || popup.decline?.(event) === true) return false;
        invoke(popup.command, popup.args);
        return consume(event);
      }
      if (!state.capturing() && event.target?.matches?.("select")) return false;
      if (event.key === "Escape") {
        const top = active.filter((layer) => layer.phase !== "capture").at(-1);
        if (top && top.decline?.(event) !== true) {
          invoke(top.command, top.args);
          return consume(event);
        }
      }
      if (state.capturing()) {
        consume(event);
        captureEvent(event);
        return true;
      }
      if (event.target?.matches?.("input, textarea, select")) return false;
      if (keymap.dispatch(event)) return consume(event, false);
      return false;
    },
  };
}
