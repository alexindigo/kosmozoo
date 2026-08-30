// client/app/components/ConfirmDelete.mjs — the delete confirmation.
//
// state.confirmDelete = { image } (card) or { images } (bulk bar) opens it.
// The host's deleteMode decides what the action means, and the wording says
// exactly what will happen:
//   trash  — assets_plus trash on the Comfy host (recoverable)
//   unlink — permanent removal from a folder host
//   hide   — the files stay on the host; the images are hidden from kosmozoo
// Bulk selections always come from one host (the current feed), so one
// deleteMode covers the whole batch.

import { h, useEffect, useState } from "../../vendor/preact/vendor.mjs";
import { state } from "../../js/state.mjs";
import { render } from "../services/notify.mjs";
import { api } from "../../js/api.mjs";
import { chrome } from "../../js/chrome.mjs";
import { closeDiff } from "../../js/diff.mjs";
import { planDeleteCurrent, popCurrent, assignCurrent, mirrorCurrentHash, stripHostPrefix, findByFile } from "../../js/route.mjs";
import { restoreToIndex } from "../../js/feed.mjs";
import { rebuildFeed } from "../services/feedView.mjs";
import { Modal } from "./Modal.mjs";

// does either workbench side show this image?
const sideMatches = (side, img) => !!side && side.source === img.host &&
  (side.file === img.filename || side.file === img.host + "#" + img.filename);

const COPY = {
  trash: {
    title: (n) => (n > 1 ? "Move to trash" : "Move to trash"),
    confirm: "Move to trash",
    body: (n, f, host) => n > 1
      ? `Move ${n} images to the trash on ${host}? Recoverable from the host's trash.`
      : `Move “${f}” to the trash on ${host}? Recoverable from the host's trash.`,
  },
  unlink: {
    title: () => "Delete file",
    confirm: "Delete forever",
    body: (n, f, host) => n > 1
      ? `Permanently delete ${n} images from ${host}? This cannot be undone.`
      : `Permanently delete “${f}” from ${host}? This cannot be undone.`,
  },
  hide: {
    title: () => "Hide image",
    confirm: "Hide",
    body: (n, f, host) => n > 1
      ? `${host} can't delete files. Hide ${n} images from kosmozoo and clear their Comfy history entries? The files themselves stay on ${host}.`
      : `${host} can't delete files. Hide “${f}” from kosmozoo and clear its Comfy history entry? The file itself stays on ${host}.`,
  },
};

export function ConfirmDelete() {
  const [busy, setBusy] = useState(false);
  const req = state.confirmDelete;
  const images = req ? (req.images ?? (req.image ? [req.image] : [])) : [];
  const n = images.length;

  const close = () => { state.confirmDelete = null; setBusy(false); render(); };

  // Esc cancels (capture: the confirmation outranks what's under it)
  useEffect(() => {
    if (!n) return;
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); close(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [req]);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // the workbench may be sitting on one of these images
      if (state.diff.open && images.some((i) => sideMatches(state.diff.left, i) || sideMatches(state.diff.right, i))) {
        closeDiff();
      }
      const results = await Promise.allSettled(images.map((img) => api.deleteImage(img.id)));
      const okIds = new Set();
      results.forEach((r, i) => {
        if (r.status === "fulfilled") {
          okIds.add(images[i].id);
          state.selected.delete(images[i].id);
        } else {
          chrome.status.error(`delete failed: ${images[i].filename}: ${r.reason?.message ?? r.reason}`);
        }
      });
      if (okIds.size === 0) { setBusy(false); return; } // nothing succeeded — stay open
      const mode = state.hosts[images[0].host]?.deleteMode ?? "hide";

      // where does the current pointer go when its image is among the
      // deleted? Computed against the PRE-delete list (adjacency needs the
      // original indices), executed after it.
      const host = images[0].host;
      const deletedFiles = new Set(images.filter((i) => okIds.has(i.id)).map((i) => i.filename));
      const plan = planDeleteCurrent(
        state.images, deletedFiles, host, state.current, state.currentStack.at(-1) ?? null);
      // deleted images are dead ends — scrub them from the back-trail
      const deletedStripped = new Set([...deletedFiles].map((f) => stripHostPrefix(host, f)));
      state.currentStack = state.currentStack.filter((p) =>
        p.remote !== host || p.image == null || !deletedStripped.has(stripHostPrefix(host, p.image)));

      state.images = state.images.filter((i) => !okIds.has(i.id));
      if (plan) {
        if (plan.kind === "pop") popCurrent();
        else if (plan.kind === "set") assignCurrent({ remote: host, image: plan.image }, { push: false });
        else assignCurrent(null, { push: false });
        mirrorCurrentHash();
      }
      rebuildFeed();
      if (plan && plan.kind !== "clear") {
        // the pointer moved — the feed follows it (scrolling IS browsing:
        // an off-viewport pointer is overridden by the next scroll settle)
        const idx = findByFile(state.current?.image);
        if (idx >= 0) restoreToIndex(idx);
      }
      chrome.status.info(mode === "hide"
        ? `${okIds.size} image${okIds.size > 1 ? "s" : ""} hidden (${images[0].host})`
        : `${okIds.size} image${okIds.size > 1 ? "s" : ""} deleted (${images[0].host})`);
      close();
    } catch (e) {
      chrome.status.error(`delete failed: ${e.message}`);
      setBusy(false);
    }
  };

  if (!n) return null;
  const mode = state.hosts[images[0].host]?.deleteMode ?? "hide";
  const copy = COPY[mode] ?? COPY.hide;
  return h(Modal, { overlayId: "confirmOverlay", panelId: "confirmPanel", open: true, onClose: close },
    h("div", { class: "confirm-title" }, copy.title(n)),
    h("div", { class: "confirm-body" }, copy.body(n, images[0].filename, images[0].host)),
    h("div", { class: "confirm-actions" },
      h("button", { class: "confirm-cancel", onClick: close, disabled: busy || undefined }, "Cancel"),
      h("button", {
        class: "confirm-ok " + mode, onClick: confirm, disabled: busy || undefined,
      }, busy ? "Working…" : copy.confirm),
    ),
  );
}
