// client-solid/main.tsx — the Solid entrypoint. Mounts <App> under the global
// store's context, then boots (boot data + initial host selection).

import { render } from "solid-js/web";
import { AppStoreContext } from "./store/app-store.js";
import { appStore } from "./store/instance.js";
import { App } from "./components/App.js";
import { FEATURES } from "./features/index.js";
import { installNoPageZoom } from "/js/no-page-zoom.mjs";

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

// key bindings — Escape precedence is structural: the dispatcher hands
// Escape to the top key layer first (an open modal, a running capture),
// then these bindings run in registration order (the keys panel closes
// before the workbench).
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
// the comparator: 1–4 pick a view (with a pair), arrows step the active
// column, Space plays the blink — the digits/arrows never fire into a
// focused text field (the dispatcher guards those already)
const wbOpen = () => store.state.diff.open && !store.state.keysPanelOpen();
const wbPair = () => wbOpen() && !!store.state.diffPair().b;
store.actions.keys.register("wb.twoUp", "1", () => store.actions.diff.setMode("two-up"), {
  when: wbPair, ctx: "workbench", desc: "comparator: Two-Up",
});
store.actions.keys.register("wb.oneUp", "2", () => store.actions.diff.setMode("one-up"), {
  when: wbPair, ctx: "workbench", desc: "comparator: One-Up (blink)",
});
store.actions.keys.register("wb.split", "3", () => store.actions.diff.setMode("split"), {
  when: wbPair, ctx: "workbench", desc: "comparator: Split wipe",
});
store.actions.keys.register("wb.difference", "4", () => store.actions.diff.setMode("difference"), {
  when: wbPair, ctx: "workbench", desc: "comparator: Difference mask",
});
store.actions.keys.register("wb.colLeft", "ArrowLeft", () => store.actions.diff.setCol("feed"), {
  when: wbPair, ctx: "workbench", desc: "comparator: feed column",
});
store.actions.keys.register("wb.colRight", "ArrowRight", () => store.actions.diff.setCol("right"), {
  when: wbPair, ctx: "workbench", desc: "comparator: right column",
});
store.actions.keys.register("wb.prev", "ArrowUp", () => store.actions.diff.step(-1), {
  when: wbOpen, ctx: "workbench", desc: "comparator: step back",
});
store.actions.keys.register("wb.next", "ArrowDown", () => store.actions.diff.step(1), {
  when: wbOpen, ctx: "workbench", desc: "comparator: step forward",
});
store.actions.keys.register("wb.play", " ", () => store.actions.diff.togglePlay(), {
  when: () => wbPair() && store.state.diff.mode === "one-up",
  ctx: "workbench", desc: "comparator: play/pause the blink",
});
document.addEventListener("keydown", (e) => store.actions.keys.dispatch(e));
