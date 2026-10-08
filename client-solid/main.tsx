// client-solid/main.tsx — the Solid entrypoint. Mounts <App> under the global
// store's context, then boots (boot data + initial host selection).

import { render } from "solid-js/web";
import { AppStoreContext } from "./store/app-store.js";
import { appStore } from "./store/instance.js";
import { App } from "./components/App.js";
import { FEATURES } from "./features/index.js";
import { installNoPageZoom } from "/js/no-page-zoom.mjs";
import { CORE_BINDINGS } from "./store/key-bindings.js";

const store = appStore;

// the page itself never zooms — browser zoom gestures over the app chrome
// are dead; image zoom lives in the app's own zoomable behavior
installNoPageZoom();

// features register into the store before anything renders (the store never
// imports a feature by name — the registry is the only place that knows them)
for (const f of FEATURES) store.actions.features.register(f);

render(
  () => (
    <AppStoreContext.Provider value={store}>
      <App />
    </AppStoreContext.Provider>
  ),
  document.getElementById("app"),
);

// boot failures surface on the status stack
store.actions.boot().catch((e) => store.actions.status.error(`load failed: ${e?.message ?? e}`));

// the URL hash mirrors the current pointer; pasted links / back-forward land
// here and are adopted into the store (replaceState mirroring never loops —
// only real navigation fires these)
window.addEventListener("hashchange", () => store.actions.route.changed());
window.addEventListener("popstate", () => store.actions.route.changed());

for (const binding of CORE_BINDINGS) store.actions.keys.register(binding);
document.addEventListener("keydown", (e) => store.actions.keys.dispatch(e, "capture"), true);
document.addEventListener("keydown", (e) => store.actions.keys.dispatch(e));
