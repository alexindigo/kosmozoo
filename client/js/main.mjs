// client/js/main.mjs — SPA entry. Wires state -> render and boots the app.

import { S, render, onRender } from "./state.mjs";
import { api } from "./api.mjs";
import { openAt, close, initLightbox } from "./lightbox.mjs";
import { addAnchorFiles } from "./anchors.mjs";
import { initRoi, setRoi } from "./roi.mjs";
import { initClientPlugins } from "./plugins-client.mjs";
import { axisStatus } from "./axes.mjs";
import { renderChunked, setVisibleRange, resetWindow, prefetchFrom } from "./volume.mjs";

const $ = (id) => document.getElementById(id);

// test seam: e2e drives the same state the keys do (window.__kz)
window.__kz = { S, setRoi };

// drag-and-drop anywhere drops anchors (local files, never uploaded)
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files?.length) await addAnchorFiles([...e.dataTransfer.files]);
});

// --- renderers (the only DOM writers) -------------------------------------

onRender((s) => {
  const picker = $("hostPicker");
  if (picker.options.length !== Object.keys(s.hosts).length) {
    picker.innerHTML = "";
    for (const [name, h] of Object.entries(s.hosts)) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = `${name}${h.online ? "" : " (offline)"}`;
      picker.appendChild(opt);
    }
  }
  if (s.host) picker.value = s.host;
});

// The grid renders card skeletons chunk by chunk; image *bytes* are loaded
// only inside the active window (volume.mjs). render() just schedules.
let gridScheduled = false;
onRender((s) => {
  if (gridScheduled) return;
  gridScheduled = true;
  requestAnimationFrame(() => {
    gridScheduled = false;
    const grid = $("grid");
    grid.innerHTML = "";
    resetWindow();
    const filter = s.filter.toLowerCase();
    const view = filter
      ? s.images.map((img, i) => [img, i]).filter(([img]) => img.filename.toLowerCase().includes(filter))
      : s.images.map((img, i) => [img, i]);
    // renderChunked builds skeletons for the *filtered view's* indices
    let i = 0;
    const step = () => {
      const end = Math.min(i + 60, view.length);
      for (; i < end; i++) {
        const [img, idx] = view[i];
        const card = document.createElement("div");
        card.className = "card";
        card.dataset.index = idx;
        if (img.judgment?.vote) card.dataset.vote = img.judgment.vote;
        if (img.judgment?.favorite) card.dataset.favorite = "1";
        const el = document.createElement("img");
        el.alt = img.filename;
        card.appendChild(el);
        grid.appendChild(card);
      }
      if (i < view.length) requestAnimationFrame(step);
      else setVisibleRange(0, Math.min(view.length, 50));
    };
    step();
  });
  const anchorsNote = s.anchors.length ? ` · ${s.anchors.length} anchor(s)` : "";
  $("status").textContent = `${s.images.length} images${anchorsNote} · ${axisStatus()}`;
});

// --- boot ------------------------------------------------------------------

async function boot() {
  await initClientPlugins(); // before axes so plugin modes are registered
  await initLightbox();
  await initRoi();
  S.hosts = await api.hosts();
  S.host = Object.keys(S.hosts)[0] ?? null;
  render();
  if (S.host) {
    S.images = await api.images(S.host);
    render();
  }
}

$("hostPicker").addEventListener("change", async (e) => {
  S.host = e.target.value;
  S.images = await api.images(S.host);
  render();
});
$("filter").addEventListener("input", (e) => { S.filter = e.target.value; render(); });
$("grid").addEventListener("click", async (e) => {
  const card = e.target.closest(".card");
  if (!card) return;
  await openAt(parseInt(card.dataset.index, 10));
});

boot().catch((e) => { $("status").textContent = `load failed: ${e.message}`; });
