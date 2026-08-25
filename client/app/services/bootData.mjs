// client/app/services/bootData.mjs — boot-time data, loaded exactly once.
//
// Hosts, ui/fields settings, scraper status and the feedback path all land in
// the shared `state`. Memoized: <App>'s init effect and the legacy boot both
// await the same promise, so the network work happens once no matter who asks
// first. `api.hosts()` is deliberately not caught — a failed host list fails
// the whole boot (the caller surfaces it), exactly as before.

import { state } from "../../js/state.mjs";
import { api } from "../../js/api.mjs";
import { loadFieldsCfg } from "../../js/fields.mjs";

let bootDataPromise = null;

export function loadBootData() {
  return (bootDataPromise ??= (async () => {
    state.hosts = await api.hosts();
    const ui = await api.settings("core.ui").catch(() => ({}));
    const fieldsStored = await api.settings("core.fields").catch(() => ({}));
    state.fieldsCfg = loadFieldsCfg(fieldsStored.cfg);
    const del = await api.settings("core.delete").catch(() => ({}));
    state.deletePrefs = { useAssetsPlus: del.useAssetsPlus ?? true };
    state.scraper = await api.scraper().catch(() => null);
    state.feedbackPath = (await api.settings("core").catch(() => ({})))?.feedbackPath ?? null;
    return { ui };
  })());
}
