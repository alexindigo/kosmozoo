// client-solid/main.tsx — the Solid entrypoint. Mounts <App> under the global
// store's context, then boots (boot data + initial host selection).

import { render } from "solid-js/web";
import { makeAppStore, AppStoreContext } from "./store/app-store.js";
import { App } from "./components/App.js";

const store = makeAppStore();

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
