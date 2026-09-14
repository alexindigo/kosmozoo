// client-solid/components/KeysPanel.tsx — the actions & keys panel. Opened
// with "?" anywhere or the keyboard icon in the workbench. Every registered
// action is listed with its effective binding; click a binding to recapture
// it, right-click resets it; overrides persist in settings core.keys.

import { For, Show } from "solid-js";
import { useAppStore } from "../store/app-store.js";
import { Modal } from "./Modal.js";

export function KeysPanel() {
  const store = useAppStore();
  const close = () => store.actions.keys.closePanel();

  const rows = () => {
    const q = (store.state.keysFilter() ?? "").toLowerCase();
    return store.state.bindings()
      .map(({ id, key, defaultKey, desc, ctx }) => ({
        id, key, defaultKey, desc: desc ?? id, ctx: ctx ?? "global",
        overridden: key !== defaultKey,
      }))
      .filter((a) => !q || `${a.desc} ${a.id} ${a.ctx}`.toLowerCase().includes(q));
  };

  return (
    <Show when={store.state.keysPanelOpen()}>
    <Modal overlayId="keysPanel" panelId="keysPanelInner" onClose={close} escapeLayer={false}>
      <div id="keysPanelHead">
        <h2>Actions & keys</h2>
        <input
          id="keysSearch" type="search" placeholder="filter actions…" spellcheck={false}
          value={store.state.keysFilter()}
          onInput={(e) => store.actions.keys.setFilter(e.target.value)}
        />
        <button
          id="keysReset" title="restore all default bindings"
          onClick={() => store.actions.keys.resetAll()}
        >reset all</button>
      </div>
      <div id="keysList">
        <For each={rows()}>
          {(a) => (
            <div class="keyrow">
              <span class="kdesc">{a.desc}</span>
              <span class="kctx">{a.ctx}</span>
              <button
                class={"kbd" + (a.overridden ? " overridden" : "")}
                title={a.overridden
                  ? `default: ${a.defaultKey} — click to rebind, right-click resets`
                  : "click to rebind"}
                onClick={() => store.actions.keys.startCapture(a.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  store.actions.keys.resetOne(a.id);
                }}
              >{store.state.capturing() === a.id ? "press keys…" : a.key}</button>
            </div>
          )}
        </For>
      </div>
      <div id="keysFoot">click a binding to change it · right-click resets one · Esc cancels capture</div>
    </Modal>
    </Show>
  );
}
