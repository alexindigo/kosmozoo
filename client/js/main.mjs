// client/js/main.mjs — SPA entry: boot, core chrome registration (through
// the same registry plugins use), and the feed's orchestration (metadata
// poll/patch, meta-want, scroll persistence, status summary).

import { state, render } from "./state.mjs";
import { api } from "./api.mjs";
import { initLightbox } from "./lightbox.mjs";
import { addAnchorFiles, initAnchorsPane, initInfoOverlay, initAnchorsWidth } from "./anchors.mjs";
import { initWorkspace } from "./workspace.mjs";
import { initDiff, openDiff, hideDiff } from "./diff.mjs";
import { parseUrl, writeFeedHash, stripHostPrefix, findByFile } from "./route.mjs";
import { initRoi, setRoi } from "./roi.mjs";
import { initClientPlugins } from "./plugins-client.mjs";
import { isVisible, initJudgment, onVisibilityChanged, toggleRevealThumbedDown, toggleHideUp, setDownvoteHides } from "./judgment.mjs";
import { chrome, initKeyDispatch } from "./chrome.mjs";
import { initKeysPanel, initKeysPanelDom, toggleKeysPanel } from "./keys-panel.mjs";
import { initHostPicker, selectHost, initialHost } from "./hostpicker.mjs";
import { initFeed, onScrollSafetyNet, restoreToIndex, resetFeed, retryImage, viewIndices } from "./feed.mjs";
import { openFieldsOverlay, initFieldsOverlay } from "./fields.mjs";
import { buildCard, savedSet } from "./card.mjs";
import { initViews } from "./views.mjs";
import { openAt, openAnchor } from "./lightbox.mjs";
import { iconSvg } from "./icons.mjs";
import { loadBootData } from "../app/services/bootData.mjs";
import { wantMeta, pollMetadata, refreshAllCardMeta } from "../app/services/metadata.mjs";
import { scraperPendingText } from "../app/services/scraper.mjs";
import { rebuildFeed, statusSummary } from "../app/services/feedView.mjs";

const $ = (id) => document.getElementById(id);

// public namespace: e2e (and the console) drives the same state the keys do
window.kosmozoo = { state, render, setRoi, addAnchorFiles, chrome, openDiff };

// drag-and-drop anywhere drops anchors (local files, never uploaded)
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files?.length) await addAnchorFiles([...e.dataTransfer.files]);
});

// --- core chrome -----------------------------------------------------------------

function registerCoreChrome() {
  chrome.headerButton({
    id: "refreshBtn", label: "Refresh", title: "re-fetch hosts and image list",
    onClick: async () => {
      state.hosts = await api.hosts();
      if (state.host) await loadCandidates();
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
      box.checked = !!state.scraper?.enabled;
      box.addEventListener("change", async () => {
        await api.setScraper({ enabled: box.checked });
        state.scraper = await api.scraper();
        render();
      });
      const track = document.createElement("span");
      track.className = "track";
      label.append(box, track, document.createTextNode("metadata scan"));
      const pause = document.createElement("button");
      pause.id = "scraperPause";
      pause.innerHTML = state.scraper?.paused ? iconSvg("player-play", 12) : iconSvg("player-pause", 12);
      pause.title = "pause/resume the background scan (laptop mode)";
      pause.addEventListener("click", async () => {
        await api.setScraper({ paused: !state.scraper?.paused });
        state.scraper = await api.scraper();
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
    get: () => state.judgment?.downvoteHides ?? true,
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
      input.value = state.feedbackPath ?? "";
      const apply = document.createElement("button");
      apply.textContent = "apply";
      apply.addEventListener("click", async () => {
        try {
          const r = await api.feedbackPath(input.value.trim());
          state.feedbackPath = r.feedbackPath;
          chrome.status.info(`feedback path → ${r.feedbackPath}`);
          if (state.host) await loadCandidates();
        } catch (err) {
          chrome.status.error(`feedback path failed: ${err.message}`);
        }
      });
      wrap.append(input, apply);
      row.append(lab, wrap);
    },
  });
}

// --- load candidates -------------------------------------------------------------

// pasted links / back button: the URL is truth — adopt it, then center.
// A filename the list doesn't have yet (fresh variations output) triggers
// one refetch; if it's still absent the URL is kept, not overwritten.
async function onUrlChange() {
  const r = parseUrl();
  if (r.view === "diff") {
    openDiff(r.left, r.right); // back/forward into a diff URL re-opens it
    return;
  }
  if (state.diff.open) hideDiff(); // back out of a diff URL, then apply feed
  if (r.host && r.host !== state.host) {
    if (!state.hosts[r.host]) return;
    await selectHost(r.host, { keepFile: true }); // hash already pristine
    return;
  }
  if (!r.file) return;
  const idx = findByFile(r.file);
  if (idx >= 0) {
    restoreToIndex(idx);
    render();
  } else {
    await loadCandidates();
  }
}

async function loadCandidates() {
  if (!state.host) return;
  // a host switch must not leave the previous host's feed on screen:
  // clear first, then load. resetFeed() drops stale card refs (an
  // innerHTML-only clear would leave cardEls pointing at removed nodes and
  // the sentinel insert crashes on the next chunk).
  state.images = [];
  resetFeed();
  $("grid").innerHTML = "";
  render();
  chrome.status.active("load", `loading image list from ${state.host}…`);
  try {
    state.images = await api.images(state.host);
    try {
      // Ask about both raw and host-prefixed filenames — new saves land
      // as `<host>#<filename>` but legacy saves may still be raw. The
      // card considers itself "saved" if either form exists on disk.
      const q = new Set();
      for (const img of state.images) {
        q.add(img.filename);
        const pfx = img.host + "#";
        if (!img.filename.startsWith(pfx)) q.add(pfx + img.filename);
      }
      const d = await api.downloadsCheck([...q]);
      savedSet.clear();
      for (const [k, v] of Object.entries(d.exists ?? {})) if (v) savedSet.add(k);
    } catch { /* save buttons just won't pre-grey */ }
    chrome.status.clear("load");
    if (!state.images.length) {
      $("grid").innerHTML = '<div class="feedempty">no output images</div>';
      chrome.status.info(`no output images on ${state.host}`);
      return;
    }
    rebuildFeed();
    chrome.status.info(statusSummary());
    // the URL is truth: re-center from it after every (re)fetch. Only a
    // first visit with no hash at all invents a current image (top card);
    // a hash the user stripped to #host stays file-less until they scroll.
    let file = parseUrl().file;
    if (!file && !location.hash) {
      const first = viewIndices()[0];
      if (first != null) {
        file = stripHostPrefix(state.host, state.images[first].filename);
      }
    }
    const target = findByFile(file);
    if (target >= 0) restoreToIndex(target);
    writeFeedHash(file);
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
  const addr = state.hosts[state.host]?.address ?? "";
  const grid = $("grid");
  grid.innerHTML = "";
  const box = document.createElement("div");
  box.className = "loadfail";
  const title = document.createElement("div");
  title.className = "loadfail-title";
  title.innerHTML = `${iconSvg("alert-triangle", 18)} couldn't load images from ${state.host}`;
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
  onVisibilityChanged((image, visible) => { if (!visible) rebuildFeed(); });
  await initViews(); // shared per-image view store (feed zoom <-> lightbox)
  initHostPicker({ onSelect: loadCandidates });
  initAnchorsPane({ onOpen: openAnchor });
  initWorkspace();
  initDiff();
  initInfoOverlay();
  initFieldsOverlay({ onChanged: refreshAllCardMeta });
  registerCoreChrome();

  initFeed({
    card: (image, imgIdx) => buildCard(image, imgIdx, {
      onOpen: () => openAt(imgIdx),          // parent wires the lightbox
      onErrorClick: () => retryImage(imgIdx), // and the feed's retry path
    }),
    onScreen: (image) => isVisible(image),
    wantMeta: (image) => wantMeta(image),
  });

  const col = $("candidatesCol");
  col.addEventListener("scroll", onScrollSafetyNet, { passive: true });
  // position persists via the URL hash (current image), not a stored px —
  // a px jump races the deep-link centering and clobbers it
  $("lbKeysBtn").addEventListener("click", (e) => { e.stopPropagation(); toggleKeysPanel(); });

  // Boot data (hosts / ui+fields settings / scraper / feedback path) loads
  // once through the memoized service; <App>'s init effect awaits the same
  // promise, so the network work happens exactly once.
  const { ui } = await loadBootData();
  await initAnchorsWidth();
  // the URL hash outranks the stored host: /#host[#filename] is shareable state
  const route = parseUrl();
  const urlHost = route.view === "diff" ? route.left?.source : route.host;
  const host = urlHost && state.hosts[urlHost] ? urlHost : initialHost(state.hosts, ui.host);
  await selectHost(host, { keepFile: true }); // hash pristine at boot
  if (route.view === "diff") openDiff(route.left, route.right);
  window.addEventListener("hashchange", onUrlChange);
  window.addEventListener("popstate", onUrlChange);
}

boot().catch((e) => chrome.status.error(`load failed: ${e.message}`));
