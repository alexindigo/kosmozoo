// client-solid/components/InfoOverlay.tsx — the ⓘ overlay: every metadata
// field an anchor image carries, picker-exempt by design (the full-details
// view). Opened from an anchor card's ⓘ button; shares <MetaBody> with the
// details pane.

import { useAppStore } from "../store/app-store.js";
import { Modal } from "./Modal.js";
import { MetaBody } from "./MetaBody.js";
import { iconSvg } from "/js/icons.mjs";

export function InfoOverlay() {
  const store = useAppStore();
  const close = () => store.actions.anchors.closeInfo();
  return (
    <Modal overlayId="infoOverlay" panelId="infoPanel" open={store.state.infoOverlay.open} onClose={close}>
      <button id="infoClose" title="close (Esc)" onClick={close} innerHTML={iconSvg("x", 16)} />
      <div id="infoTitle">{store.state.infoOverlay.name}</div>
      <div id="infoBody" class="metabody">
        <MetaBody meta={store.state.infoOverlay.meta ?? null} host={null} compareMeta={null} />
      </div>
    </Modal>
  );
}
