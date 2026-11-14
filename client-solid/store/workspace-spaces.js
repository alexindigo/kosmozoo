// Generic workspace catalogue. Retain the persisted candidate until assembly has
// registered all feature descriptors; unknown spaces never become Details by proxy.
export function makeWorkspaceSpaces(saved = "details") {
  const spaces = new Map([
    ["details", { id: "details", title: "image details", icon: "info-circle", chrome: "details", component: null }],
    ["anchors", { id: "anchors", title: "anchors", icon: "anchor", chrome: "cards", component: null }],
  ]);
  return {
    list: () => [...spaces.values()], has: id => spaces.has(id),
    resolve: () => spaces.has(saved) ? saved : "details",
    components(components) { for (const [id, component] of Object.entries(components)) spaces.set(id, { ...spaces.get(id), component }); },
    register(entries) {
      const ids = new Set(spaces.keys());
      for (const entry of entries) {
        if (!entry || typeof entry.id !== "string" || ids.has(entry.id) || typeof entry.title !== "string" || typeof entry.icon !== "string" || typeof entry.component !== "function") throw new Error("Invalid or duplicate workspace contribution");
        ids.add(entry.id);
      }
      for (const entry of entries) spaces.set(entry.id, Object.freeze({ chrome: "plain", ...entry }));
    },
  };
}
