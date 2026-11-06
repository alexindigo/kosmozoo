import { assertEquals } from "jsr:@std/assert";
import { makeAppStore } from "../client-solid/store/app-store.js";
import { api } from "../client/js/api.mjs";
import { clientInventory } from "./helpers/client-inventory.mjs";

Deno.test("viewer opacity: Store context owns availability/effect without resetting raw preferences", async () => {
  const saved = { ...api };
  api.collections = async () => ({ fake: { address: "fake:1", kind: "comfy", online: true } });
  api.inventory = async () => clientInventory(["still.png", "peer.png", "movie.webm", "sound.wav"].map(name => ({ name, width: 100, height: 80 })));
  api.meta = async () => ({ v: 1, pending: 0 });
  api.want = async () => ({ pending: 0 });
  api.nodes = api.settings = api.setSettings = async () => ({});
  api.prefetch = async () => ({ pending: {} });
  const store = makeAppStore({ subscribeSources: null });
  const invoke = (id, args) => store.handles.invoke(id, args);
  try {
    await store.actions.boot();
    invoke("workbench.parameters", { parameter: "activeOpacity", value: .4 });
    invoke("workbench.parameters", { parameter: "opacity", value: .25 });
    for (const file of ["still.png", "movie.webm", "sound.wav"]) {
      invoke("workbench.openPair", { left: { source: "fake", file }, right: { source: "fake", file: "peer.png" } });
      for (const { mode } of store.state.diffViews()) {
        invoke("workbench.mode", { mode });
        const p = store.state.diffPresentation();
        const eligible = mode !== "full";
        assertEquals(p.activeOpacity, { available: eligible, value: eligible ? .4 : 1 }, `${file}/${mode}`);
        assertEquals(p.highlightOpacity, { available: mode === "difference", value: mode === "difference" ? .25 : 1 });
        assertEquals(store.state.diff.activeOpacity, .4);
        assertEquals(store.state.diff.diffOpacity, .25);
      }
    }
    // Retire the explicit peer through the ordinary current/workspace owner.
    store.actions.current.assign({ remote: "fake", image: "still.png" }, { persist: false });
    store.actions.ui.setWorkspace("details");
    invoke("workbench.mode", { mode: "two-up" });
    assertEquals(store.state.diffPair().b, null);
    assertEquals(store.state.diffPresentation().activeOpacity, { available: false, value: 1 });
    assertEquals(store.state.diff.activeOpacity, .4);
    invoke("workbench.openPair", { left: { source: "fake", file: "still.png" }, right: { source: "fake", file: "peer.png" } });
    assertEquals(store.state.diffPresentation().activeOpacity.value, 1, "reopen starts in Full");
    invoke("workbench.mode", { mode: "difference" });
    assertEquals(store.state.diffPresentation().activeOpacity.value, .4);
    assertEquals(store.state.diffPresentation().highlightOpacity.value, .25);
  } finally { store.dispose(); Object.assign(api, saved); }
});
