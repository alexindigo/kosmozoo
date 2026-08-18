// client/js/main.mjs — SPA entry. Wires state -> render and boots the app.

import { S, render, onRender } from "./state.mjs";
import { api } from "./api.mjs";
import { openAt, close, initLightbox } from "./lightbox.mjs";
import { addAnchorFiles } from "./anchors.mjs";
import { initRoi } from "./roi.mjs";

const $ = (id) => document.getElementById(id);

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

onRender((s) => {
  const grid = $("grid");
  grid.innerHTML = "";
  const filter = s.filter.toLowerCase();
  for (let i = 0; i < s.images.length; i++) {
    const img = s.images[i];
    if (filter && !img.filename.toLowerCase().includes(filter)) continue;
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.index = i;
    if (img.judgment?.vote) card.dataset.vote = img.judgment.vote;
    if (img.judgment?.favorite) card.dataset.favorite = "1";
    const el = document.createElement("img");
    el.loading = "lazy";
    el.src = api.imageBytesUrl(img.id);
    el.alt = img.filename;
    card.appendChild(el);
    grid.appendChild(card);
  }
  const anchorsNote = s.anchors.length ? ` · ${s.anchors.length} anchor(s)` : "";
  $("status").textContent = `${s.images.length} images${anchorsNote}`;
});

// lightbox visibility is driven by lightbox.mjs (lbShow/close); nothing here
// writes its DOM directly.

// --- boot ------------------------------------------------------------------

async function boot() {
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
