// ComfyUI links are input values, not arbitrary arrays in widget/metadata data.
// Both pruning and submission validation use the same link interpretation.
function linkInputs(node) {
  return Object.entries(node?.inputs ?? {}).filter(([, value]) =>
    Array.isArray(value) && value.length === 2 &&
    (typeof value[0] === "string" || Number.isSafeInteger(value[0])) &&
    Number.isInteger(value[1]) && value[1] >= 0);
}

export function dependencyClosure(graph, rootId) {
  const kept = new Set(), pending = [String(rootId)];
  while (pending.length) {
    const id = pending.pop();
    if (kept.has(id)) continue;
    kept.add(id);
    for (const [, link] of linkInputs(graph[id])) pending.push(String(link[0]));
  }
  return kept;
}

export function validateGraphLinks(graph) {
  for (const [id, node] of Object.entries(graph)) {
    for (const [key, link] of linkInputs(node)) {
      if (!Object.hasOwn(graph, link[0])) throw new Error(`Dangling ComfyUI link: ${id}.${key} references missing node ${link[0]}`);
    }
  }
}
