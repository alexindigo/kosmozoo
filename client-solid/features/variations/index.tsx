// client-solid/features/variations/index.tsx — the variations feature:
// batch parameter sweep from a card. Exports the feature contract:
// { install, Modal, cardAction, bulkAction }.

import { iconSvg } from "/js/icons.mjs";
import { VariationsModal } from "./VariationsModal.js";
import * as api from "./api.js";
import { makeVariationSession } from "./session.js";
import { variationCommands } from "./commands.js";
import { sourceOrigin, validOrigin } from "/shared/source-origin.mjs";
import { createRoot, createSignal } from "solid-js";
import { makeHistoryClient } from "./history-client.js";
import { HistoryPanel } from "./HistoryPanel.js";

// Assembly injects modal services and registers owner-safe command definitions.
export function install(store) {
  return createRoot(disposeRoot => {
  const [historyRevision, setHistoryRevision] = createSignal(0);
  const history = makeHistoryClient({ api, changed: () => setHistoryRevision(n => n + 1) });
  const historyState = () => { historyRevision(); return history.state(); };
  const activate = () => history.activate();
  window.addEventListener("focus", activate); window.addEventListener("pageshow", activate);
  const broker = makeVariationSession({ read: () => store.state.variations,
    write: (opening) => store.setSt("variations", store.reconcile(opening)) });
  const services = {
    // modal I/O — the feature's api.js owns the transport; the modal keeps
    // session-scoped results (probe params, file lists) in local signals
    probe(image) { return api.probe(image); },
    generationTime: api.generationTime,
    history, historyState, historyThumbnail: api.historyThumbnail,
    inputList(hostName, origin, root = "input") { return api.inputList(hostName, origin, root); },
    uploadInput(hostName, form, origin) { return api.uploadInput(hostName, form, origin); },
    inspectImage: api.inspectImage,
    inputThumbnail: api.inputThumbnail,
    readInput: api.readInput,
    inputSources: () => Object.keys(store.state.hosts).filter(host => store.state.hosts[host].kind === "comfy" && store.state.hosts[host].capabilities?.list !== false)
      .map(host => sourceOrigin(host, store.state.hosts[host])).filter(validOrigin),
    // Thumbnail bytes share the feed's engine route and browser connections:
    // they join the Store's one acquisition policy as foreground displays.
    registerThumbnail: input => store.surfaceDisplay(input),
    listFolder: api.listFolder,
    folderCapability: api.folderCapability,
    chooseFolder: api.chooseFolder,
    pathThumbnail: api.pathThumbnail,
    inspectPath: api.inspectPath,
    uploadPath: api.uploadPath,
    async run(payload) {
      if (!payload.history) throw new Error("A durable history capture is required before Run");
      const { ok, status, text } = await api.run(payload);
      let data = null;
      try { data = api.readRunResult(text); } catch { /* non-JSON error body */ }
      return { ok, status, data, text };
    },
  };
  return {
    workspaceSpaces: [{ id: "variation-history", title: "Variations history", icon: "history", component: HistoryPanel,
      ports: { history, state: historyState, thumbnail: api.historyThumbnail, registerThumbnail: input => store.surfaceDisplay(input),
        recall: id => store.handles.invoke("variations.history.open", { id }) } }],
    dispose() { window.removeEventListener("focus", activate); window.removeEventListener("pageshow", activate); const cleanup = history.dispose(); disposeRoot(); return cleanup; },
    ownedCommands: [
      ...["variations.discard.cancel", "variations.images.close"].map(id => ({ id, validate: args => Object.keys(args).length === 0 })),
      { id: "variations.tabs.move", validate: args => Object.keys(args).length === 1 && [-1, 1, "first", "last"].includes(args.step) },
      { id: "variations.feed-tabs.move", validate: args => Object.keys(args).length === 1 && [-1, 1, "first", "last"].includes(args.step) },
    ],
    commands: [...variationCommands({ state: store.state, broker }),
      { id: "variations.history.open", description: "recall original variation run", validate: args => Object.keys(args).length === 1 && typeof args.id === "string",
        async execute({ id }) {
          const opening = broker.captureOpening();
          const record = await history.open(id);
          let result;
          try { result = await broker.openHistory(record, opening); }
          catch (error) { try { await history.release(record); } catch { /* retained by history owner */ } throw error; }
          if (result.status !== "applied") await history.release(record);
          return result;
        } }],
    ports: {
      services,
      registerOwner: broker.register,
      open: (image) => store.handles.invoke("variations.open", { id: image.id }),
    },
  };
  });
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
