// client-solid/features/variations/index.tsx — the variations feature:
// batch parameter sweep from a card. Exports the feature contract:
// { actions, Modal, cardAction, bulkAction }.

import { IconButton } from "../../components/IconButton.js";
import { iconSvg } from "/js/icons.mjs";
import { VariationsModal } from "./VariationsModal.js";
import * as api from "./api.js";

// The modal reads these through store.actions.variations; they are thin
// bindings over the feature's own transport.
export function actions(store) {
  return {
    // wand toggle: re-clicking the same image's wand closes the modal
    open(image) {
      const key = image?.id ?? null;
      if (store.state.variations.open && store.state.variations.key === key) {
        store.actions.variations.close();
        return;
      }
      store.setSt("variations", store.reconcile({ open: true, images: [image], key }));
    },
    // bulk bar's wand: RELATIVE sweeps applied to every selected image
    // around its own current value — even for a single image
    openBulk(images) {
      const key = "batch:" + images.map((i) => i.id).join("|");
      if (store.state.variations.open && store.state.variations.key === key) {
        store.actions.variations.close();
        return;
      }
      store.setSt("variations", store.reconcile({ open: true, images, key }));
    },
    close() { store.setSt("variations", store.reconcile({ open: false, images: [], key: null })); },

    // modal I/O — the feature's api.js owns the transport; the modal keeps
    // session-scoped results (probe params, file lists) in local signals
    probe(image) { return api.probe(image.id).catch(() => null); },
    inputList(hostName) { return api.inputList(hostName); },
    uploadInput(hostName, form) { return api.uploadInput(hostName, form); },
    async run(payload) {
      const { ok, status, text } = await api.run(payload);
      let data = null;
      try { data = JSON.parse(text); } catch { /* non-JSON error body */ }
      return { ok, status, data, text };
    },
  };
}

export function Modal() {
  return <VariationsModal />;
}

export const cardAction = {
  icon: iconSvg("wand", 16),
  variant: "variations",
  title: "generate variations",
  onAction: (store, image) => store.actions.variations.open(image),
};

export const bulkAction = {
  icon: iconSvg("wand", 16),
  variant: "variations",
  title: "generate variations of all selected (one relative sweep, applied to each)",
  onAction: (store) => store.actions.variations.openBulk(store.actions.bulk.images()),
};

export { IconButton };
