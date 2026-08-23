// client/js/keys-panel.mjs — the actions & keys panel. Opened with "?"
// anywhere or the keyboard icon in the lightbox. Every registered action is
// listed with its effective binding; click a binding to recapture it;
// overrides persist in settings core.keys.

import { state, render, onRender } from "./state.mjs";
import { api } from "./api.mjs";
import {
  chrome, actionsList, rebind, resetKey, resetAllKeys,
  comboFromEvent, setCaptureHook, setKeymap,
} from "./chrome.mjs";

const $ = (id) => document.getElementById(id);

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

export function initKeysPanelDom() {
  $("keysSearch").addEventListener("input", (e) => {
    state.keysFilter = e.target.value;
    render();
  });
  $("keysReset").addEventListener("click", async () => {
    const saved = await api.settings("core.keys").catch(() => ({}));
    resetAllKeys();
    for (const id of Object.keys(saved)) {
      api.setSettings("core.keys", { [id]: null }).catch(() => {});
    }
    chrome.status.info("keys reset to defaults");
    render();
  });
  $("keysPanel").addEventListener("click", (e) => {
    if (e.target.id === "keysPanel") toggleKeysPanel(); // backdrop closes
  });
}

onRender(() => {
  if (typeof document === "undefined") return;
  const panel = $("keysPanel");
  if (!panel) return;
  panel.hidden = !state.keysPanelOpen;
  if (!state.keysPanelOpen) return;

  const list = $("keysList");
  list.innerHTML = "";
  const q = (state.keysFilter ?? "").toLowerCase();
  for (const a of actionsList()) {
    if (q && !`${a.desc} ${a.id} ${a.ctx}`.toLowerCase().includes(q)) continue;
    const row = document.createElement("div");
    row.className = "keyrow";
    const desc = document.createElement("span");
    desc.className = "kdesc";
    desc.textContent = a.desc;
    const ctx = document.createElement("span");
    ctx.className = "kctx";
    ctx.textContent = a.ctx;
    const kbd = document.createElement("button");
    kbd.className = "kbd" + (a.overridden ? " overridden" : "");
    kbd.dataset.action = a.id;
    kbd.textContent = state.capturing === a.id ? "press keys…" : a.key;
    kbd.title = a.overridden
      ? `default: ${a.defaultKey} — click to rebind, right-click resets`
      : "click to rebind";
    kbd.addEventListener("click", () => { state.capturing = a.id; render(); });
    kbd.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      resetKey(a.id);
      api.setSettings("core.keys", { [a.id]: null }).catch(() => {});
      render();
    });
    row.append(desc, ctx, kbd);
    list.appendChild(row);
  }
});
