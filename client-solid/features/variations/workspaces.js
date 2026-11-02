// App-session recipe lifetime, private to this feature. Opening metadata never
// carries recipes or Files. No eviction: editable leave decisions or app disposal.
import { makeVariationRecipe, freezeRecipe } from "./recipe.js";
import { snapshotDraft } from "./draft.js";
import { sameOrigin } from "/shared/source-origin.mjs";

const identities = targets => targets.map(target => target.id).sort();
const sameTargets = (a, b) => JSON.stringify(identities(a)) === JSON.stringify(identities(b));
export const workspaceCurrent = (workspace, targets) => sameTargets(workspace.targets, targets) &&
  workspace.targets.every(target => sameOrigin(target.origin, targets.find(other => other.id === target.id)?.origin));

export function makeVariationWorkspaces() {
  const retained = new Set(), leases = new Set();
  let sequence = 0, alive = true;
  const options = targets => [...retained].filter(workspace => sameTargets(workspace.targets, targets));
  const fresh = targets => {
    if (!alive) throw new Error("Recipe workspaces disposed");
    const existing = options(targets).find(workspace => workspaceCurrent(workspace, targets));
    if (existing) return existing;
    const workspace = Object.freeze({ id: `recipe-${++sequence}`, targets: freezeRecipe(snapshotDraft(targets)), recipe: makeVariationRecipe() });
    retained.add(workspace); return workspace;
  };
  return {
    options, fresh,
    lease(retire) { if (!alive) throw new Error("Recipe workspaces disposed"); leases.add(retire); return () => leases.delete(retire); },
    open(targets) { const candidates = options(targets); return candidates.find(workspace => workspaceCurrent(workspace, targets)) ?? candidates.at(-1) ?? fresh(targets); },
    remove(workspace) { retained.delete(workspace); },
    dispose() { alive = false; for (const retire of leases) retire(); leases.clear(); retained.clear(); },
  };
}
