// Confirmation owns a captured source and previewed names, never a live filter
// or selection. Views only present this projection and forward semantic intents.
export const downVotedDeleteLabel = source => `Delete down-voted images from ${source} source`;
export const deletionEffect = mode => mode === "trash" ? "They go to ComfyUI's trash." :
  mode === "unlink" ? "The files are deleted." : "They are hidden.";
const errorText = error => error?.detail || error?.message || String(error);

export function makeDownVotedDeletion({ capture, isCurrent, read, publish, preview, remove, apply, status, closeMenu }) {
  let ticket = null, disposed = false;
  const owns = value => !disposed && ticket === value && read()?.kind === "down-voted";
  const update = (value, patch) => { if (owns(value)) publish({ ...read(), ...patch }); };
  function cancel() {
    if (read()?.phase === "deleting") return false;
    ticket?.controller.abort(); ticket = null; publish(null); return true;
  }
  return {
    async request() {
      if (read()?.phase === "deleting") return false;
      const source = capture();
      if (!source) return false;
      ticket?.controller.abort();
      const value = { source, controller: new AbortController(), names: null };
      ticket = value; closeMenu();
      publish({ kind: "down-voted", source: source.id, phase: "preview", count: null, capability: null, error: "" });
      try {
        const result = await preview(source, { signal: value.controller.signal });
        if (!owns(value)) return false;
        if (!isCurrent(source)) throw Error("Source changed. Cancel and open a new preview.");
        value.names = [...result.names];
        update(value, { phase: "ready", count: value.names.length, capability: result.capability });
        return true;
      } catch (error) {
        update(value, { phase: "error", error: errorText(error) }); return false;
      }
    },
    async confirm() {
      const value = ticket;
      if (!owns(value) || read().phase !== "ready" || !value.names?.length) return false;
      if (!isCurrent(value.source)) { update(value, { phase: "error", error: "Source changed. Cancel and open a new preview." }); return false; }
      update(value, { phase: "deleting", error: "" });
      try {
        const result = await remove(value.source, [...value.names]);
        if (!owns(value)) return false;
        if (isCurrent(value.source)) apply(value.source, result.deleted);
        status(`${result.deleted.length} deleted, ${result.skipped.length} skipped, ${result.failed.length} failed`);
        ticket = null; publish(null);
        return true;
      } catch (error) {
        // A transport failure can conceal completed effects. Do not offer an
        // automatic retry of the captured destructive request.
        update(value, { phase: "error", error: `Could not confirm the deletion result: ${errorText(error)}. Cancel and preview again.` });
        return false;
      }
    },
    cancel,
    dispose() { disposed = true; ticket?.controller.abort(); ticket = null; },
  };
}
