// client/js/main.mjs — SPA entry: boot, core chrome registration (through
// the same registry plugins use), and the feed's orchestration (metadata
// poll/patch, meta-want, scroll persistence, status summary).

import { S, render, onRender } from "./state.mjs";
import { api } from "./api.mjs";
import { initLightbox } from "./lightbox.mjs";
import { addAnchorFiles, initAnchorsPane, initInfoOverlay, initAnchorsWidth } from "./anchors.mjs";
import { initRoi, setRoi } from "./roi.mjs";
import { initClientPlugins } from "./plugins-client.mjs";
import { axisStatus } from "./axes.mjs";
import { isVisible, initJudgment, toggleRevealThumbedDown, toggleHideUp, setDownvoteHides } from "./judgment.mjs";
import { chrome, initKeyDispatch, toggleMenu } from "./chrome.mjs";
import { initKeysPanel, initKeysPanelDom, toggleKeysPanel } from "./keys-panel.mjs";
import { initHostPicker, selectHost, initialHost } from "./hostpicker.mjs";
import { initFeed, renderFeed, onScrollSafetyNet, cardAt, restoreScroll, resetFeed } from "./feed.mjs";
import { loadFieldsCfg, openFieldsOverlay, initFieldsOverlay } from "./fields.mjs";
import { buildCard, patchCardMeta, savedSet } from "./card.mjs";
import { initViews } from "./views.mjs";
import { iconSvg } from "./icons.mjs";

const $ = (id) => document.getElementById(id);

// test seam: e2e drives the same state the keys do
window.__kz = { S, setRoi, addAnchorFiles, chrome, render };

// drag-and-drop anywhere drops anchors (local files, never uploaded)
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files?.length) await addAnchorFiles([...e.dataTransfer.files]);
});

// --- metadata channel: poll + patch in place + scroll-driven wants --------------

let metaVersion = 0;
let metaPending = 0;
let metaPollTimer = null;
const wantSet = new Set();
let wantTimer = null;

function wantMeta(image) {
  if (image.meta || wantSet.has(image.filename)) return;
  wantSet.add(image.filename);
  clearTimeout(wantTimer);
  wantTimer = setTimeout(flushWant, 1500);
}

async function flushWant() {
  if (!S.host) return;
  const files = [...wantSet];
  wantSet.clear();
  if (!files.length) return;
  try {
    const r = await api.metaWant(S.host, files);
    if (typeof r.pending === "number") {
      metaPending = r.pending;
      updateScanChip();
      if (metaPending > 0) scheduleMetaPoll();
    }
  } catch { /* next render re-wants */ }
}

function scheduleMetaPoll(delay = 5000) {
  clearTimeout(metaPollTimer);
  metaPollTimer = setTimeout(pollMetadata, delay);
}

async function pollMetadata() {
  if (!S.host) return;
  try {
    const r = await api.metadata(S.host);
    metaPending = r.pending ?? 0;
    updateScanChip();
    if (r.v !== metaVersion) {
      metaVersion = r.v;
      mergeMetadata(r.items ?? {});
    }
  } catch { /* transient; next poll retries */ }
  if (metaPending > 0) scheduleMetaPoll();
}

// A card rendered before its metadata arrived gets patched in place.
function mergeMetadata(items) {
  for (const [name, meta] of Object.entries(items)) {
    const idx = S.images.findIndex((i) => i.filename === name);
    if (idx < 0) continue;
    if (!S.images[idx].meta) S.images[idx].meta = meta;
    const card = cardAt(idx);
    if (card) patchCardMeta(card, meta);
  }
}

function updateScanChip() {
  if (metaPending > 0) chrome.status.active("meta", `metadata scan — ${metaPending} left`);
  else chrome.status.clear("meta");
}

// --- core chrome -----------------------------------------------------------------

function statusSummary() {
  const hidden = S.images.filter((i) => i.judgment?.vote === "down").length;
  const base = S.filter
    ? `${viewCount()} of ${S.images.length} matching “${S.filter}” from ${S.host}`
    : `${S.images.length} images from ${S.host}`;
  return base + (hidden ? ` (${hidden} hidden)` : "");
}

function viewCount() {
  const q = S.filter.toLowerCase();
  return S.images.filter((i) =>
    (!q || i.filename.toLowerCase().includes(q)) && isVisible(i)).length;
}

function rebuildFeed() {
  const q = S.filter.toLowerCase();
  const view = [];
  for (let i = 0; i < S.images.length; i++) {
    const img = S.images[i];
    if (q && !img.filename.toLowerCase().includes(q)) continue;
    if (!isVisible(img)) continue;
    view.push(i);
  }
  renderFeed($("grid"), view);
}

function registerCoreChrome() {
  chrome.headerButton({
    id: "refreshBtn", label: "Refresh", title: "re-fetch hosts and image list",
    onClick: async () => {
      S.hosts = await api.hosts();
      if (S.host) await loadCandidates();
      chrome.status.info("refreshed");
    },
  });
  chrome.headerButton({
    id: "unhideBtn", label: "Unhide", title: "temporarily show thumbed-down images (votes are kept)",
    onClick: () => {
      const on = toggleRevealThumbedDown();
      rebuildFeed();
      chrome.status.info(on ? "thumbed-down revealed (temporary)" : "thumbed-down hidden");
    },
  });
  chrome.headerButton({
    id: "hideUpBtn", label: "Hide up-voted", title: "hide thumbed-up images for this session (reload restores)",
    onClick: () => {
      const on = toggleHideUp();
      rebuildFeed();
      chrome.status.info(on ? "thumbed-up hidden this session" : "thumbed-up visible");
    },
  });

  chrome.menuItem({
    id: "scraper", kind: "custom", searchText: "metadata scan",
    render(row) {
      const label = document.createElement("label");
      label.className = "switchwrap";
      label.title = "walk the host's image list and extract PNG-embedded metadata in the background";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = !!S.scraper?.enabled;
      box.addEventListener("change", async () => {
        await api.setScraper({ enabled: box.checked });
        S.scraper = await api.scraper();
        render();
      });
      const track = document.createElement("span");
      track.className = "track";
      label.append(box, track, document.createTextNode("metadata scan"));
      const pause = document.createElement("button");
      pause.id = "scraperPause";
      pause.innerHTML = S.scraper?.paused ? iconSvg("player-play", 12) : iconSvg("player-pause", 12);
      pause.title = "pause/resume the background scan (laptop mode)";
      pause.addEventListener("click", async () => {
        await api.setScraper({ paused: !S.scraper?.paused });
        S.scraper = await api.scraper();
        render();
      });
      const counter = document.createElement("span");
      counter.id = "scraperPending";
      counter.className = "menuextra";
      counter.textContent = scraperPendingText();
      row.append(label, pause, counter);
    },
  });

  chrome.menuItem({
    id: "fields", kind: "action", label: "metadata fields…",
    searchText: "metadata fields card strip picker",
    onClick: () => openFieldsOverlay(),
  });

  chrome.menuItem({
    id: "downvote-hides", kind: "toggle",
    label: "down-vote hides",
    title: "thumbs-down removes an image from view (reveal with the Unhide button)",
    get: () => S.judgment?.downvoteHides ?? true,
    set: (v) => setDownvoteHides(v),
  });

  chrome.menuItem({
    id: "feedback-path", kind: "custom", searchText: "feedback.json path",
    render(row) {
      const lab = document.createElement("div");
      lab.className = "menulabel";
      lab.textContent = "feedback.json path";
      const wrap = document.createElement("div");
      wrap.className = "fbpathrow";
      const input = document.createElement("input");
      input.type = "text";
      input.spellcheck = false;
      input.value = S.feedbackPath ?? "";
      const apply = document.createElement("button");
      apply.textContent = "apply";
      apply.addEventListener("click", async () => {
        try {
          const r = await api.feedbackPath(input.value.trim());
          S.feedbackPath = r.feedbackPath;
          chrome.status.info(`feedback path → ${r.feedbackPath}`);
          if (S.host) await loadCandidates();
        } catch (err) {
          chrome.status.error(`feedback path failed: ${err.message}`);
        }
      });
      wrap.append(input, apply);
      row.append(lab, wrap);
    },
  });
}

function scraperPendingText() {
  const p = S.scraper?.pending ?? {};
  const total = Object.values(p).reduce((a, b) => a + b, 0);
  return total > 0 ? `${total} left` : "";
}

// status line in the header shows the axes; the summary sentence goes through
// the transient chip on load/vote, per the cadence
onRender((s) => {
  $("status").textContent = axisStatus();
});

// --- load candidates -------------------------------------------------------------

async function loadCandidates() {
  if (!S.host) return;
  // a host switch must not leave the previous host's feed on screen:
  // clear first, then load. resetFeed() drops stale card refs (an
  // innerHTML-only clear would leave cardEls pointing at removed nodes and
  // the sentinel insert crashes on the next chunk).
  S.images = [];
  resetFeed();
  $("grid").innerHTML = "";
  render();
  chrome.status.active("load", `loading image list from ${S.host}…`);
  try {
    S.images = await api.images(S.host);
    try {
      const d = await api.downloadsCheck(S.images.map((i) => i.filename));
      savedSet.clear();
      for (const [k, v] of Object.entries(d.exists ?? {})) if (v) savedSet.add(k);
    } catch { /* save buttons just won't pre-grey */ }
    chrome.status.clear("load");
    if (!S.images.length) {
      $("grid").innerHTML = '<div class="empty">no output images</div>';
      chrome.status.info(`no output images on ${S.host}`);
      return;
    }
    rebuildFeed();
    chrome.status.info(statusSummary());
    const ui = await api.settings("core.ui").catch(() => ({}));
    const y = ui[`scroll.${S.host}`];
    if (y) restoreScroll(y);
    await pollMetadata();
    render(); // surfaces reflect the loaded host (picker label, axes, etc.)
  } catch (err) {
    chrome.status.clear("load");
    showLoadError(err);
  }
}

// Load failures get the body, not just the status line: what failed, what to
// try, and a retry button.
function showLoadError(err) {
  const addr = S.hosts[S.host]?.address ?? "";
  const grid = $("grid");
  grid.innerHTML = "";
  const box = document.createElement("div");
  box.className = "loadfail";
  const title = document.createElement("div");
  title.className = "loadfail-title";
  title.innerHTML = `${iconSvg("alert-triangle", 18)} couldn't load images from ${S.host}`;
  const detail = document.createElement("div");
  detail.className = "loadfail-detail";
  detail.textContent = String(err?.message ?? err);
  const steps = document.createElement("ol");
  steps.className = "loadfail-steps";
  const items = [
    "Retry — ComfyUI stalls its API while generating; a moment later it often just works.",
    addr ? `Check the host directly: ${addr} (its queue page).` : null,
    "If the host was reconfigured, fix or re-add it in the host picker (top-left).",
  ].filter(Boolean);
  for (const t of items) {
    const li = document.createElement("li");
    li.textContent = t;
    steps.appendChild(li);
  }
  const btn = document.createElement("button");
  btn.className = "loadfail-retry";
  btn.textContent = "Retry / refresh";
  btn.addEventListener("click", loadCandidates);
  box.append(title, detail, steps, btn);
  grid.appendChild(box);
}

// --- boot --------------------------------------------------------------------------

async function boot() {
  await initClientPlugins(); // before axes so plugin modes are registered
  initKeyDispatch();
  await initKeysPanel(); // BEFORE lightbox keys: the panel outranks on Escape
  initKeysPanelDom();
  await initLightbox();
  await initRoi();
  await initJudgment();
  await initViews(); // shared per-image view store (feed zoom <-> lightbox)
  initHostPicker({ onSelect: loadCandidates });
  initAnchorsPane();
  initInfoOverlay();
  initFieldsOverlay();
  registerCoreChrome();

  initFeed({
    card: (image, imgIdx) => buildCard(image, imgIdx),
    onScreen: (image) => isVisible(image),
    wantMeta: (image) => wantMeta(image),
  });

  $("menuBtn").addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(); });
  document.addEventListener("click", (e) => {
    if (S.menuOpen && !$("menuWrap").contains(e.target)) { S.menuOpen = false; render(); }
  });
  const col = $("candidatesCol");
  col.addEventListener("scroll", onScrollSafetyNet, { passive: true });
  col.addEventListener("scroll", () => {
    clearTimeout(boot._scrollSave);
    boot._scrollSave = setTimeout(() => {
      if (S.host && !S.filter) { // filtered views aren't the host list
        api.setSettings("core.ui", { [`scroll.${S.host}`]: col.scrollTop }).catch(() => {});
      }
    }, 400);
  }, { passive: true });
  $("lbKeysBtn").addEventListener("click", (e) => { e.stopPropagation(); toggleKeysPanel(); });

  S.hosts = await api.hosts();
  const ui = await api.settings("core.ui").catch(() => ({}));
  const fieldsStored = await api.settings("core.fields").catch(() => ({}));
  S.fieldsCfg = loadFieldsCfg(fieldsStored.cfg);
  S.scraper = await api.scraper().catch(() => null);
  S.feedbackPath = (await api.settings("core").catch(() => ({})))?.feedbackPath ?? null;
  await initAnchorsWidth();
  await selectHost(initialHost(S.hosts, ui.host)); // selects + loadCandidates via onSelect

  // scraper status chip + menu counter: poll every 2s
  setInterval(async () => {
    S.scraper = await api.scraper().catch(() => S.scraper);
    const counter = $("scraperPending");
    if (counter) counter.textContent = scraperPendingText();
  }, 2000);
}

$("filter").addEventListener("input", (e) => { S.filter = e.target.value; rebuildFeed(); });

boot().catch((e) => chrome.status.error(`load failed: ${e.message}`));
