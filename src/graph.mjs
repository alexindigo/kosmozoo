// ComfyUI links are input values, not arbitrary arrays in widget/metadata data.
export function linkInputs(node) {
  return Object.entries(node?.inputs ?? {}).filter(([, value]) =>
    Array.isArray(value) && value.length === 2 &&
    (typeof value[0] === "string" || Number.isSafeInteger(value[0])) &&
    Number.isInteger(value[1]) && value[1] >= 0);
}

// One traversal for pruning and telemetry. The edge predicate lets telemetry
// infer completed strong ancestors without treating lazy inputs as evaluated.
export function dependencyClosure(graph, roots, accept = () => true) {
  const kept = new Set(), pending = (Array.isArray(roots) ? roots : [roots]).map(String);
  while (pending.length) {
    const id = pending.pop();
    if (kept.has(id)) continue;
    kept.add(id);
    for (const [key, link] of linkInputs(graph[id])) {
      if (accept(graph[id], key)) pending.push(String(link[0]));
    }
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
