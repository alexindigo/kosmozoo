// client-solid/main.tsx — the Solid entrypoint. Mounts <App> under the global
// store's context, then boots (boot data + initial host selection).

import { render } from "solid-js/web";
import { AppStoreContext } from "./store/app-store.js";
import { appStore } from "./store/instance.js";
import { App } from "./components/App.js";

const store = appStore;

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

// key bindings — registration order is the Escape precedence: the keys panel
// closes first, then the workbench. The delete confirmation's capture-phase
// listener beats both.
store.actions.keys.register("app.keys", "?", () => store.actions.keys.togglePanel(), {
  desc: "actions & keys panel", ctx: "global",
});
store.actions.keys.register("keys.close", "Escape", () => store.actions.keys.closePanel(), {
  when: () => store.state.keysPanelOpen() && !store.state.capturing(),
  desc: "close panel", ctx: "keys",
});
store.actions.keys.register("wb.close", "Escape", () => store.actions.diff.close(), {
  when: () => store.state.diff.open && !store.state.keysPanelOpen(),
  ctx: "workbench", desc: "close the workbench",
});
document.addEventListener("keydown", (e) => store.actions.keys.dispatch(e));

// drag-and-drop anywhere drops anchors (local files, never uploaded)
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files?.length) await store.actions.anchors.addFiles([...e.dataTransfer.files]);
});
