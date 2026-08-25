// client/app/components/ConfirmDelete.mjs — the delete confirmation.
//
// state.confirmDelete = { image } opens it. The host's deleteMode decides
// what the action means, and the wording says exactly what will happen:
//   trash  — assets_plus trash on the Comfy host (recoverable)
//   unlink — permanent removal from a folder host
//   hide   — the file stays on the host; the image is hidden from kosmozoo

import { h, useEffect, useState } from "../../vendor/preact/vendor.mjs";
import { state } from "../../js/state.mjs";
import { render } from "../services/notify.mjs";
import { api } from "../../js/api.mjs";
import { chrome } from "../../js/chrome.mjs";
import { close as closeLightbox } from "../../js/lightbox.mjs";
import { rebuildFeed } from "../services/feedView.mjs";
import { Modal } from "./Modal.mjs";

const COPY = {
  trash: {
    title: "Move to trash",
    confirm: "Move to trash",
    body: (f, host) => `Move “${f}” to the trash on ${host}? Recoverable from the host's trash.`,
  },
  unlink: {
    title: "Delete file",
    confirm: "Delete forever",
    body: (f, host) => `Permanently delete “${f}” from ${host}? This cannot be undone.`,
  },
  hide: {
    title: "Hide image",
    confirm: "Hide",
    body: (f, host) => `${host} can't delete files. Hide “${f}” from kosmozoo and clear its Comfy history entry? The file itself stays on ${host}.`,
  },
};

export function ConfirmDelete() {
  const [busy, setBusy] = useState(false);
  const image = state.confirmDelete?.image ?? null;
  const imageId = image?.id ?? null;

  const close = () => { state.confirmDelete = null; setBusy(false); render(); };

  // Esc cancels (capture: the confirmation outranks what's under it)
  useEffect(() => {
    if (!imageId) return;
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); close(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [imageId]);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // the lightbox may be sitting on exactly this image
      if (state.lightbox.open && state.images[state.lightbox.index]?.id === imageId) {
        await closeLightbox();
      }
      const r = await api.deleteImage(imageId);
      // off the visible feed immediately; real deletes never re-list, and
      // hidden files stay filtered out engine-side on every listing
      state.images = state.images.filter((i) => i.id !== imageId);
      rebuildFeed();
      chrome.status.info(r.mode === "hide"
        ? `${image.filename} hidden (${image.host})`
        : `${image.filename} deleted (${image.host})`);
      close();
    } catch (e) {
      chrome.status.error(`delete failed: ${e.message}`);
      setBusy(false);
    }
  };

  if (!image) return null;
  const mode = state.hosts[image.host]?.deleteMode ?? "hide";
  const copy = COPY[mode] ?? COPY.hide;
  return h(Modal, { overlayId: "confirmOverlay", panelId: "confirmPanel", open: true, onClose: close },
    h("div", { class: "confirm-title" }, copy.title),
    h("div", { class: "confirm-body" }, copy.body(image.filename, image.host)),
    h("div", { class: "confirm-actions" },
      h("button", { class: "confirm-cancel", onClick: close, disabled: busy || undefined }, "Cancel"),
      h("button", {
        class: "confirm-ok " + mode, onClick: confirm, disabled: busy || undefined,
      }, busy ? "Working…" : copy.confirm),
    ),
  );
}
