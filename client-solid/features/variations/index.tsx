// client-solid/features/variations/index.tsx — the variations feature:
// batch parameter sweep from a card. Exports the feature contract:
// { install, Modal, cardAction, bulkAction }.

import { IconButton } from "../../components/IconButton.js";
import { iconSvg } from "/js/icons.mjs";
import { VariationsModal } from "./VariationsModal.js";
import * as api from "./api.js";
import { makeVariationSession } from "./session.js";
import { variationCommands } from "./commands.js";

// Assembly injects modal services and registers owner-safe command definitions.
export function install(store) {
  const broker = makeVariationSession({ read: () => store.state.variations,
    write: (opening) => store.setSt("variations", store.reconcile(opening)) });
  const services = {
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
  return {
    ownedCommands: [{ id: "variations.discard.cancel", validate: (args) => Object.keys(args).length === 0 }],
    commands: variationCommands({ state: store.state, broker }),
    ports: {
      services,
      registerOwner: broker.register,
      open: (image) => store.handles.invoke("variations.open", { id: image.id }),
      openBulk: (images) => store.handles.invoke("variations.open", { ids: images.map((image) => image.id), bulk: true }),
      close: () => store.handles.invoke("variations.close"),
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
  command: "variations.open",
};

export const bulkAction = {
  icon: iconSvg("wand", 16),
  variant: "variations",
  title: "generate variations of all selected (one relative sweep, applied to each)",
  command: "variations.open", args: { bulk: true },
};

export { IconButton };
