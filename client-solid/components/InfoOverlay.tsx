// client-solid/components/InfoOverlay.tsx — the ⓘ overlay: every metadata
// field an anchor image carries, picker-exempt by design (the full-details
// view). Opened from an anchor card's ⓘ button; shares <MetaBody> with the
// details pane.

import { useAppStore } from "../store/app-store.js";
import { Modal } from "./Modal.js";
import { MetaBody } from "./MetaBody.js";

const CLOSE_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6l-12 12" /><path d="M6 6l12 12" /></svg>';

export function InfoOverlay() {
  const store = useAppStore();
  const close = () => store.actions.anchors.closeInfo();
  return (
    <Modal overlayId="infoOverlay" panelId="infoPanel" open={store.state.infoOverlay.open} onClose={close}>
      <button id="infoClose" title="close (Esc)" onClick={close} innerHTML={CLOSE_SVG} />
      <div id="infoTitle">{store.state.infoOverlay.name}</div>
      <div id="infoBody" class="metabody">
        <MetaBody meta={store.state.infoOverlay.meta ?? null} host={null} compareMeta={null} />
      </div>
    </Modal>
  );
}
