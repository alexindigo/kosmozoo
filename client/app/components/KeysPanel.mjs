// client/app/components/KeysPanel.mjs — the actions & keys panel. Opened with
// "?" anywhere or the keyboard icon in the lightbox. Every registered action
// is listed with its effective binding; click a binding to recapture it,
// right-click resets it; overrides persist in settings core.keys.

import { h } from "../../vendor/preact/vendor.mjs";
import { state } from "../../js/state.mjs";
import { render } from "../services/notify.mjs";
import { api } from "../../js/api.mjs";
import { chrome, actionsList, resetKey, resetAllKeys } from "../../js/chrome.mjs";
import { Modal } from "./Modal.mjs";

export function KeysPanel() {
  const close = () => { state.keysPanelOpen = false; state.capturing = null; render(); };

  const q = (state.keysFilter ?? "").toLowerCase();
  const rows = [];
  for (const a of actionsList()) {
    if (q && !`${a.desc} ${a.id} ${a.ctx}`.toLowerCase().includes(q)) continue;
    rows.push(h("div", { class: "keyrow", key: a.id },
      h("span", { class: "kdesc" }, a.desc),
      h("span", { class: "kctx" }, a.ctx),
      h("button", {
        class: "kbd" + (a.overridden ? " overridden" : ""),
        "data-action": a.id,
        title: a.overridden
          ? `default: ${a.defaultKey} — click to rebind, right-click resets`
          : "click to rebind",
        onClick: () => { state.capturing = a.id; render(); },
        onContextMenu: (e) => {
          e.preventDefault();
          resetKey(a.id);
          api.setSettings("core.keys", { [a.id]: null }).catch(() => {});
          render();
        },
      }, state.capturing === a.id ? "press keys…" : a.key),
    ));
  }

  return h(Modal, { overlayId: "keysPanel", panelId: "keysPanelInner", open: state.keysPanelOpen, onClose: close },
    h("div", { id: "keysPanelHead" },
      h("h2", null, "Actions & keys"),
      h("input", {
        id: "keysSearch", type: "search", placeholder: "filter actions…", spellcheck: false,
        value: state.keysFilter,
        onInput: (e) => { state.keysFilter = e.target.value; render(); },
      }),
      h("button", {
        id: "keysReset", title: "restore all default bindings",
        onClick: async () => {
          const saved = await api.settings("core.keys").catch(() => ({}));
          resetAllKeys();
          for (const id of Object.keys(saved)) {
            api.setSettings("core.keys", { [id]: null }).catch(() => {});
          }
          chrome.status.info("keys reset to defaults");
          render();
        },
      }, "reset all"),
    ),
    h("div", { id: "keysList" }, rows),
    h("div", { id: "keysFoot" }, "click a binding to change it · right-click resets one · Esc cancels capture"),
  );
}
