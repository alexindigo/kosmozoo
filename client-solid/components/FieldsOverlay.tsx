// client-solid/components/FieldsOverlay.tsx — the metadata fields picker.
// Per-field toggles plus per-group masters, all derived from the store's
// stored cfg; a change persists and the cards' under-image rows refresh by
// construction. Master↔per-field sync falls out of reactivity.

import { For, Show } from "solid-js";
import { useAppStore } from "../store/app-store.js";
import { fieldGroupsOf } from "../store/fields.js";
import { Modal } from "./Modal.js";
import { iconSvg } from "/js/icons.mjs";

export function FieldsOverlay() {
  const store = useAppStore();
  const close = () => store.actions.fieldsOverlay.close();
  const groups = () => fieldGroupsOf(store.state.nodesRegistry);
  const cfg = () => store.state.fieldsCfg();

  return (
    <Modal overlayId="fieldsOverlay" panelId="fieldsPanel" open={store.state.fieldsOverlayOpen()} onClose={close}>
      <button id="fieldsClose" title="close (Esc)" onClick={close} innerHTML={iconSvg("x", 16)} />
      <div id="fieldsTitle">Metadata fields</div>
      <div id="fieldsSub">
        <b>under image</b> — the card's metadata panel
      </div>
      <div id="fieldsTable">
        <Show when={cfg()}>
          <div class="frow head">
            <span class="fname2">field (grouped by node)</span><span>under image</span>
          </div>
          <For each={groups()}>
            {([gname, fields]) => (
              <div class="fgroup">
                <div class="fgrouphead">
                  <span class="gname">{gname}</span>
                  {["card"].map((col) => (
                    <label
                      class="switchwrap mini"
                      title={`toggle all ${gname} (under image)`}
                    >
                      <input
                        type="checkbox"
                        checked={fields.some(([id]) => !!cfg()[id]?.[col])}
                        onChange={(e) => store.actions.fieldsOverlay.setGroup(
                          fields.map(([id]) => id), col, e.target.checked)}
                      />
                      <span class="track" />
                    </label>
                  ))}
                </div>
                <div class="fgroupbody" data-group={gname}>
                  <For each={fields}>
                    {([id, input]) => (
                      <div class="frow">
                        <span class="fname2">{id}</span>
                        {["card"].map((col) => (
                          <label class="switchwrap mini">
                            <input
                              type="checkbox"
                              checked={!!cfg()[id]?.[col]}
                              onChange={(e) => store.actions.fieldsOverlay.setField(id, col, e.target.checked)}
                            />
                            <span class="track" />
                          </label>
                        ))}
                      </div>
                    )}
                  </For>
                </div>
              </div>
            )}
          </For>
        </Show>
      </div>
    </Modal>
  );
}
