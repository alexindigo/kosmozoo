// client/js/plugins-client.mjs — the client plugin host.
//
// Loads each discovered plugin's client half (/plugins/<name>/client.js) and
// hands it a small client-side surface. Dynamic import() is the mechanism —
// already proven in the outgoing code. The composition registry is what the
// difference plugin hangs off.

import { S, render } from "./state.mjs";
import { api } from "./api.mjs";

const compositionModes = new Map(); // id -> { label, apply, clear, amplify? }

export function compositionModesList() {
  return [...compositionModes.entries()].map(([id, m]) => ({ id, label: m.label ?? id }));
}

export async function applyComposition(id, candidateEl, anchorEl) {
  // clear any previous mode first
  for (const [, m] of compositionModes) m.clear?.(candidateEl, anchorEl);
  const m = compositionModes.get(id);
  if (m) await m.apply?.(candidateEl, anchorEl);
}

export async function initClientPlugins() {
  let plugins = [];
  try {
    plugins = await api.plugins();
  } catch {
    return; // engine without plugin host — absent, not broken
  }
  for (const p of plugins) {
    if (!p.hasClient) continue;
    try {
      const mod = await import(`/plugins/${p.name}/client.js`);
      if (typeof mod.register === "function") {
        mod.register({
          composition: (id, def) => compositionModes.set(id, def),
          // future client surfaces (menuItem, key) register here
        });
      }
    } catch (e) {
      // a failing plugin client must not break the workbench
      console.warn(`plugin client ${p.name} failed:`, e);
    }
  }
  render();
}
