// client-solid/main.tsx — the Solid entrypoint. Mounts <App> under the global
// store's context, then boots (boot data + initial host selection).

import { render } from "solid-js/web";
import { makeAppStore, AppStoreContext } from "./store/app-store.js";
import { App } from "./components/App.js";

const store = makeAppStore();

// public namespace: e2e (and the console) drive the same state the UI does.
// Grows with the phases; the preact app's shape is the cutover contract.
window.kosmozoo = { state: store.state, actions: store.actions };

render(
  () => (
    <AppStoreContext.Provider value={store}>
      <App />
    </AppStoreContext.Provider>
  ),
  document.getElementById("app"),
);

// boot failures surface on the console until the status chrome lands
store.actions.boot().catch((e) => console.error(`load failed: ${e?.message ?? e}`));

// the URL hash mirrors the current pointer; pasted links / back-forward land
// here and are adopted into the store (replaceState mirroring never loops —
// only real navigation fires these)
window.addEventListener("hashchange", () => store.actions.route.changed());
window.addEventListener("popstate", () => store.actions.route.changed());
