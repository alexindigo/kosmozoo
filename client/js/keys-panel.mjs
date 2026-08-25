// client/js/keys-panel.mjs — the actions & keys panel service: action
// bindings, the capture hook and the persisted keymap. <KeysPanel> renders
// the panel itself; this module keeps only what has no DOM.

import { state } from "./state.mjs";
import { render } from "../app/services/notify.mjs";
import { api } from "./api.mjs";
import {
  chrome, rebind,
  comboFromEvent, setCaptureHook, setKeymap,
} from "./chrome.mjs";

export function toggleKeysPanel() {
  state.keysPanelOpen = !state.keysPanelOpen;
  state.capturing = null;
  render();
}

export async function initKeysPanel() {
  chrome.bind("app.keys", "?", () => toggleKeysPanel(), { desc: "actions & keys panel", ctx: "global" });
  chrome.bind("keys.close", "Escape", () => {
    if (state.keysPanelOpen && !state.capturing) { state.keysPanelOpen = false; render(); }
  }, { when: () => state.keysPanelOpen, desc: "close panel", ctx: "keys" });

  setCaptureHook((e) => {
    const id = state.capturing;
    if (!id) return;
    if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      state.capturing = null; // plain Escape cancels capture
      render();
      return;
    }
    const combo = comboFromEvent(e);
    const res = rebind(id, combo);
    if (res.conflict) {
      chrome.status.error(`${combo} already bound to ${res.conflict}`);
    } else {
      api.setSettings("core.keys", { [id]: combo }).catch(() => {});
      chrome.status.info(`${id} → ${combo}`);
    }
    state.capturing = null;
    render();
  });

  const saved = await api.settings("core.keys").catch(() => ({}));
  setKeymap(saved);
}
