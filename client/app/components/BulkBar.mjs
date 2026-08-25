// client/app/components/BulkBar.mjs — bulk actions on the selected images.
//
// Appears fixed under the header while at least one card is selected.
// Judgments are set-all (predictable for batches): thumbs-up makes every
// selected image up-voted. The selection survives vote/favorite/save so
// actions chain; only delete drops the affected images from it.

import { h } from "../../vendor/preact/vendor.mjs";
import { state } from "../../js/state.mjs";
import { render } from "../services/notify.mjs";
import { api } from "../../js/api.mjs";
import { chrome } from "../../js/chrome.mjs";
import { iconSvg } from "../../js/icons.mjs";
import { rebuildFeed } from "../services/feedView.mjs";
import { IconButton } from "./IconButton.mjs";
import { toggleVariationsBulk } from "./VariationsModal.mjs";

function selectedImages() {
  return state.images.filter((i) => state.selected.has(i.id));
}

export function BulkBar() {
  const n = state.selected.size;
  if (n === 0) return null;
  const images = selectedImages();
  const host = state.host;

  const clear = () => { state.selected.clear(); render(); };

  const bulkVote = async (vote) => {
    await Promise.all(images.map((img) =>
      api.setJudgment(img.id, { vote }).then(() => {
        if (!img.judgment) img.judgment = {};
        img.judgment.vote = vote;
      }).catch((e) => chrome.status.error(`vote failed: ${img.filename}: ${e.message}`))));
    rebuildFeed(); // down-vote may hide the images from view
    render();
    chrome.status.info(`${images.length} image${images.length > 1 ? "s" : ""} ${vote === "up" ? "up-voted" : "down-voted"}`);
  };

  const bulkFavorite = async () => {
    await Promise.all(images.map((img) =>
      api.setJudgment(img.id, { favorite: true }).then(() => {
        if (!img.judgment) img.judgment = {};
        img.judgment.favorite = true;
      }).catch((e) => chrome.status.error(`favorite failed: ${img.filename}: ${e.message}`))));
    render();
    chrome.status.info(`${images.length} image${images.length > 1 ? "s" : ""} favorited`);
  };

  const bulkSave = () => {
    for (const img of images) {
      const a = document.createElement("a");
      a.href = api.imageBytesUrl(img.id);
      a.download = img.filename.startsWith(img.host + "#") ? img.filename : img.host + "#" + img.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    chrome.status.info(`saving ${images.length} image${images.length > 1 ? "s" : ""}`);
  };

  const deleteMode = state.hosts[host]?.deleteMode ?? "hide";

  return h("div", { id: "bulkBar" },
    h("span", { id: "bulkCount" }, `${n} selected`),
    h(IconButton, {
      icon: iconSvg("wand", 16), variant: "variations",
      title: "generate variations of all selected (one relative sweep, applied to each)",
      onAction: () => toggleVariationsBulk(images),
    }),
    h(IconButton, {
      icon: iconSvg("thumb-down"), variant: "down",
      title: "thumbs-down all selected (hides, if down-vote hides is on)",
      onAction: () => bulkVote("down"),
    }),
    h(IconButton, {
      icon: iconSvg("thumb-up"), variant: "up",
      title: "thumbs-up all selected",
      onAction: () => bulkVote("up"),
    }),
    h(IconButton, {
      icon: iconSvg("star"), variant: "favorite",
      title: "favorite all selected",
      onAction: bulkFavorite,
    }),
    h("button", {
      class: "savebtn", title: "download all selected (the browser may ask to allow multiple)",
      onClick: bulkSave,
    }, "save"),
    h(IconButton, {
      icon: iconSvg(deleteMode === "hide" ? "eye-off" : "trash", 16), variant: "delete",
      title: deleteMode === "trash" ? "move all selected to trash on the host (recoverable)"
        : deleteMode === "unlink" ? "delete all selected files from the host folder (permanent)"
        : "hide all selected from kosmozoo (this host can't delete files)",
      onAction: () => { state.confirmDelete = { images }; render(); },
    }),
    h("button", { id: "bulkClear", title: "clear selection", onClick: clear }, "×"),
  );
}
