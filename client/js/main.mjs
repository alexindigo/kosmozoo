// client/js/main.mjs — SPA entry. Wires state -> render and boots the app.

import { S, render, onRender } from "./state.mjs";
import { api } from "./api.mjs";
import { openAt, close, initLightbox } from "./lightbox.mjs";
import { addAnchorFiles } from "./anchors.mjs";
import { initRoi, setRoi } from "./roi.mjs";
import { initClientPlugins } from "./plugins-client.mjs";
import { axisStatus } from "./axes.mjs";
import { isVisible, initJudgment } from "./judgment.mjs";
import { renderChunked, setVisibleRange, resetWindow, prefetchFrom } from "./volume.mjs";

const $ = (id) => document.getElementById(id);

// test seam: e2e drives the same state the keys do (window.__kz)
window.__kz = { S, setRoi, addAnchorFiles };

// drag-and-drop anywhere drops anchors (local files, never uploaded)
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files?.length) await addAnchorFiles([...e.dataTransfer.files]);
});

// --- renderers (the only DOM writers) -------------------------------------

onRender((s) => {
  const picker = $("hostPicker");
  const names = Object.keys(s.hosts).join(""); // rebuild on any set change
  if (picker.dataset.names !== names) {
    picker.dataset.names = names;
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

// The grid renders card skeletons chunk by chunk via volume.mjs (which keeps
// the cardEls registry the window loader reads); image *bytes* load only
// inside the active window. Judgment visibility (down-vote hides) and the
// filename filter both shape the view here.
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
    const view = [];
    for (let i = 0; i < s.images.length; i++) {
      const img = s.images[i];
      if (filter && !img.filename.toLowerCase().includes(filter)) continue;
      if (!isVisible(img)) continue; // down-voted and not revealed
      view.push(i);
    }
    renderChunked(grid, view, (card, img) => {
      if (img.judgment?.vote) card.dataset.vote = img.judgment.vote;
      if (img.judgment?.favorite) card.dataset.favorite = "1";
    }, () => {
      // initial window: the first screenful
      const cols = Math.max(1, Math.floor(grid.clientWidth / 186));
      setVisibleRange(0, Math.min(view.length, cols * 4));
    });
  });
  const anchorsNote = s.anchors.length ? ` · ${s.anchors.length} anchor(s)` : "";
  $("status").textContent = `${s.images.length} images${anchorsNote} · ${axisStatus()}`;
});

// Scroll wiring: the window's scroll half is estimated from grid geometry
// (fixed row height via aspect-ratio), rAF-throttled. This is mechanism #2
// (scroll safety net) of the three-mechanism progress design.
let scrollTick = false;
window.addEventListener("scroll", () => {
  if (scrollTick) return;
  scrollTick = true;
  requestAnimationFrame(() => {
    scrollTick = false;
    const grid = $("grid");
    const first = grid.querySelector(".card");
    if (!first) return;
    const rowH = first.getBoundingClientRect().height + 6; // card + gap
    const cols = Math.max(1, Math.floor(grid.clientWidth / (first.getBoundingClientRect().width + 6)));
    const lo = Math.max(0, Math.floor(window.scrollY / rowH) * cols - cols);
    const hi = Math.min(S.images.length - 1, Math.ceil((window.scrollY + window.innerHeight) / rowH) * cols + cols);
    setVisibleRange(lo, hi);
  });
}, { passive: true });

// Per-host scroll position: restored on host switch (mechanism #3,
// programmatic restore), persisted in settings.
const scrollSave = { t: null };
window.addEventListener("scroll", () => {
  clearTimeout(scrollSave.t);
  scrollSave.t = setTimeout(() => {
    if (S.host) api.setSettings("core.ui", { [`scroll.${S.host}`]: window.scrollY }).catch(() => {});
  }, 500);
}, { passive: true });

// --- boot ------------------------------------------------------------------

async function boot() {
  await initClientPlugins(); // before axes so plugin modes are registered
  await initLightbox();
  await initRoi();
  await initJudgment();
  S.hosts = await api.hosts();
  S.host = Object.keys(S.hosts)[0] ?? null;
  render();
  if (S.host) {
    S.images = await api.images(S.host);
    render();
    const saved = await api.settings("core.ui").catch(() => ({}));
    if (saved[`scroll.${S.host}`]) {
      requestAnimationFrame(() => window.scrollTo(0, saved[`scroll.${S.host}`]));
    }
  }
}

$("hostPicker").addEventListener("change", async (e) => {
  S.host = e.target.value;
  S.images = await api.images(S.host);
  render();
});
$("hostAdd").addEventListener("click", async () => {
  const input = prompt("Add host  (name=host:port)", "");
  if (!input) return;
  const eq = input.indexOf("=");
  if (eq < 1) { $("status").textContent = "host must be name=host:port"; return; }
  try {
    await api.addHost(input.slice(0, eq).trim(), input.slice(eq + 1).trim());
    S.hosts = await api.hosts();
    render();
  } catch (err) {
    $("status").textContent = `add host failed: ${err.message}`;
  }
});
$("hostRemove").addEventListener("click", async () => {
  if (!S.host) return;
  if (!confirm(`Remove host "${S.host}"?`)) return;
  try {
    await api.removeHost(S.host);
    S.hosts = await api.hosts();
    S.host = Object.keys(S.hosts)[0] ?? null;
    S.images = S.host ? await api.images(S.host) : [];
    render();
  } catch (err) {
    $("status").textContent = `remove host failed: ${err.message}`;
  }
});
$("filter").addEventListener("input", (e) => { S.filter = e.target.value; render(); });
$("grid").addEventListener("click", async (e) => {
  const card = e.target.closest(".card");
  if (!card) return;
  await openAt(parseInt(card.dataset.index, 10));
});

boot().catch((e) => { $("status").textContent = `load failed: ${e.message}`; });
