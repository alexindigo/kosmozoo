// Feature semantic definitions over injected composition/owner operations.
import { isEntryName } from "/shared/entry-path.mjs";
import { sourceOrigin } from "/shared/source-origin.mjs";

export function variationCommands({ state, broker }) {
  const resolve = (id) => {
    const live = state.images[state.imageIdxById().get(id)];
    if (live) return live;
    const separator = id.indexOf(":");
    if (separator < 1) return null;
    const host = id.slice(0, separator), filename = id.slice(separator + 1);
    if (!state.hosts[host] || !isEntryName(state.hosts[host].kind, filename)) return null;
    // Explicit retained/cross-source targets are addresses, not positions in the
    // currently visible inventory. Their own probe resolves the graph as before.
    return { id, host, filename, meta: null };
  };
  return [
    { id: "variations.open", description: "generate variations", validate: (a) =>
      Object.keys(a).every((key) => ["id", "ids", "target", "bulk"].includes(key)) &&
      ["id", "ids", "target"].filter((key) => Object.hasOwn(a, key)).length === 1 &&
      (a.id !== undefined ? typeof a.id === "string" && !!a.id : a.ids !== undefined ? Array.isArray(a.ids) && a.ids.every((id) => typeof id === "string" && !!id) : a.target === "selected") &&
      (a.bulk === undefined || typeof a.bulk === "boolean"),
      execute(a) {
        const ids = a.id ? [a.id] : a.ids ? [...a.ids] : state.images.filter((image) => state.selected[image.id]).map((image) => image.id);
        const images = ids.map(resolve).map(image => image ? { ...image, origin: sourceOrigin(image.host, state.hosts[image.host]) } : null);
        return images.some((image) => !image) ? Promise.resolve({ status: "stale" }) : broker.open(images, a.bulk ?? !a.id);
      } },
    { id: "variations.close", validate: (a) => Object.keys(a).every((key) => ["automatic", "session"].includes(key)) &&
      (a.automatic === undefined || typeof a.automatic === "boolean") && (a.session === undefined || typeof a.session === "string"), execute: broker.close },
    { id: "variations.run", validate: (a) => Object.keys(a).length === 0, execute: () => broker.run() },
  ];
}
