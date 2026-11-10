import { parameterCurrent, stringifyExactJson } from "/shared/parameters.mjs";
import { validateEditorValue } from "/shared/features/variations/compile.mjs";

// Presentation over the complete catalogue, never a supported-input registry.
export const parameterInputName = row => row.contract?.display?.display_name || row.input || row.key;
export const parameterNodeTitle = row => row.title ?? row.type ?? "Node";
export const parameterNodeName = row => `${parameterNodeTitle(row)} #${row.nodeIds?.[0] ?? row.id}`;
export const parameterName = row => `${parameterNodeName(row)}: ${parameterInputName(row)}`;
export const parameterContext = row => row.valueKind === "connection"
  ? `Node ${parameterCurrent(row)[0]}, output ${parameterCurrent(row)[1]}`
  : row.domain === "images" ? `${row.current} (${row.currentRoot ?? "input"})`
  : typeof parameterCurrent(row) === "string" ? parameterCurrent(row) : stringifyExactJson(parameterCurrent(row));

const section = row => row.domain === "images" || row.contract?.resource?.media === "image" ? "Images"
  : row.domain === "texts" ? "Text" : row.domain === "numeric" || row.domain === "enums" ? "Adjustments" : "Other inputs";
const priority = row => /denoise|strength/i.test(row.input ?? row.key) ? 0
  : /steps|cfg|guidance|sampler|scheduler|seed/i.test(row.input ?? row.key) ? 1 : 2;

export function cataloguePresentation(rows) {
  return ["Images", "Text", "Adjustments", "Other inputs"].map(name => {
    const nodes = new Map();
    for (const row of rows.filter(row => section(row) === name).sort((a, b) => priority(a) - priority(b))) {
      const id = row.nodeIds?.[0] ?? row.id;
      if (!nodes.has(id)) nodes.set(id, { id, label: parameterNodeName(row), ids: [] });
      nodes.get(id).ids.push(row.id);
    }
    return { name, nodes: [...nodes.values()] };
  }).filter(group => group.nodes.length);
}

export function matchesFieldFilter(row, filter) {
  const query = filter.trim().toLowerCase();
  const identity = [parameterName(row), row.displayName, row.label, row.id, row.type,
    `${row.type}.${row.input ?? row.key}`, ...(row.aliases ?? [])].join(" ").toLowerCase();
  return !query || identity.includes(query);
}

export function connectionPresentation(parameter, nodes) {
  return nodes.map(node => ({ ...node, label: `${node.title ?? node.type} #${node.id}`,
    outputs: node.outputs === null ? null : (node.outputs ?? []).flatMap((port, slot) => {
      try { validateEditorValue(parameter, [node.id, slot], nodes); }
      catch { return []; }
      return [{ slot: String(slot), label: `${port.name ?? port.type ?? "Output"} (${slot})` }];
    }) })).filter(node => node.outputs === null || node.outputs.length);
}
