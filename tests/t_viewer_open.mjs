import { assertEquals } from "jsr:@std/assert";
import { makeAppStore } from "../client-solid/store/app-store.js";
import { api } from "../client/js/api.mjs";
import { clientInventory } from "./helpers/client-inventory.mjs";

for (const opener of ["feed", "metadata", "anchor", "deep-a", "deep-b"]) {
  Deno.test(`viewer opens on clicked subject: ${opener}`, async () => {
    const saved = { ...api }, location = globalThis.location, history = globalThis.history;
    const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    globalThis.location = { pathname: "/", hash: "", search: "" };
    globalThis.history = { replaceState() {}, pushState() {} };
    api.collections = async () => ({ fake: { address: "fake:1", kind: "comfy", online: true } });
    api.inventory = async () => clientInventory(["a.png", "b.png"].map(name => ({ name, width: 100, height: 80 })));
    api.meta = async () => ({ v: 1, pending: 0 });
    api.want = async () => ({ pending: 0 });
    api.nodes = async () => ({});
    api.settings = async () => ({});
    api.setSettings = async () => ({});
    api.prefetch = async () => ({ pending: {} });
    const store = makeAppStore({ subscribeSources: null });
    try {
      await store.actions.boot();
      store.actions.current.assign({ remote: "fake", image: "a.png" }, { persist: false });
      const a = { source: "fake", file: "a.png" }, b = { source: "input:fake", file: "b.png" };
      // Seed a remembered anchor through the same persisted anchor ingress as boot.
      if (opener === "anchor") {
        Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: key => key === "kosmozoo.anchors.v1" ? JSON.stringify([{ name: "ref.png", src: "data:image/png;base64,AA==" }]) : null, setItem() {} } });
        store.actions.anchors.load();
        store.actions.ui.setWorkspace("anchors");
        assertEquals(store.state.anchors.length, 1);
      }
      if (opener === "feed") store.handles.invoke("workbench.openEntry", { id: "fake:b.png" });
      if (opener === "metadata") store.handles.invoke("workbench.pickInput", { source: "fake", file: "b.png" });
      if (opener === "anchor") store.handles.invoke("workbench.pickAnchor", { name: "ref.png" });
      if (opener.startsWith("deep")) store.handles.invoke("workbench.openPair", { left: a, right: b, ...(opener === "deep-b" ? { subject: "b" } : {}) });
      const expected = opener === "anchor" ? { source: "anchor", file: "ref.png" }
        : opener === "metadata" || opener === "deep-b" ? b
        : { source: "fake", file: opener === "feed" ? "b.png" : "a.png" };
      assertEquals(store.state.diff.open, true);
      assertEquals(store.state.diff.mode, "full");
      // The rendering contract, not just the opener's intermediate slot writes.
      const displayed = () => store.state.diffPair()[store.state.diff.col === "right" ? "b" : "a"];
      assertEquals(displayed(), expected);
      for (const mode of ["two-up", "one-up", "split", "difference", "full"]) {
        store.handles.invoke("workbench.mode", { mode });
        assertEquals(displayed(), expected, mode);
      }
    } finally {
      store.dispose();
      Object.assign(api, saved);
      globalThis.location = location; globalThis.history = history;
      if (opener === "anchor") {
        if (storage) Object.defineProperty(globalThis, "localStorage", storage);
        else delete globalThis.localStorage;
      }
    }
  });
}
