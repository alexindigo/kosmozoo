// client-solid/components/Header.tsx — the top chrome, declarative.
//
// Phase 1 shape: logo/title, host picker, filter box, download-feedback link,
// options button. #headerButtons and the menu rows fill in as their features
// land (feed/judgment buttons phase 2, menu items with the settings surfaces).
// The layout switcher appears with the details pane (phase 3).

import { onCleanup } from "solid-js";
import { For, Show } from "solid-js/web";
import { useAppStore } from "../store/app-store.js";
import { nodeImages } from "../store/fields.js";
import { HostPicker } from "./HostPicker.js";

// layout-switcher icons: a square with one divider — vertical right of
// center (wide images / narrow text), horizontal (stacked), vertical left
// of center (narrow text / wide images)
const LAYOUT_SPLIT_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" /></svg>';
const LAYOUT_STACKED_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="3" y1="15" x2="21" y2="15" /></svg>';
const LAYOUT_REV_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" /></svg>';

const LAYOUT_MODES = [
  ["split", LAYOUT_SPLIT_SVG, "images left / metadata right"],
  ["stacked", LAYOUT_STACKED_SVG, "images above / metadata below"],
  ["rev", LAYOUT_REV_SVG, "metadata left / images right"],
];

// the layout switcher applies to the details pane's current image: shown
// only when the details space is on and that image's graph references
// discovered input images
function InfoLayoutSwitcher() {
  const store = useAppStore();
  const applicable = () => {
    if (store.state.workspace() !== "details") return false;
    const c = store.state.current();
    if (!c || c.remote === "anchor") return false;
    const img = store.state.images.find((i) => i.host === c.remote &&
      (i.filename === c.image || i.filename === c.remote + "#" + c.image));
    return !!(img?.host && nodeImages(img.meta ?? null, img.host).length);
  };
  return (
    <Show when={applicable()}>
      <span id="infoLayout">
        <For each={LAYOUT_MODES}>
          {([mode, svg, title]) => (
            <button
              class={store.state.infoLayout() === mode ? "on" : ""}
              title={"info layout: " + title}
              onClick={() => store.actions.ui.setInfoLayout(mode)}
              innerHTML={svg}
            />
          )}
        </For>
      </span>
    </Show>
  );
}

export function Header() {
  const store = useAppStore();
  let menuWrapRef;

  // click outside the menu closes it (menuBtn's own click stops propagation)
  const onDocClick = (e) => {
    if (store.state.menuOpen() && menuWrapRef && !menuWrapRef.contains(e.target)) {
      store.actions.ui.closeMenu();
    }
  };
  document.addEventListener("click", onDocClick);
  onCleanup(() => document.removeEventListener("click", onDocClick));

  return (
    <header id="chrome">
      <img src="/logo-64.png" alt="kosmozoo" width={24} height={24} style="border-radius:6px" />
      <h1>Kosmozoo</h1>
      <HostPicker />
      <input
        id="filter"
        type="search"
        placeholder="filter filenames…"
        spellcheck={false}
        onInput={(e) => store.actions.ui.setFilter(e.target.value)}
      />
      <span id="headerButtons">
        <button
          id="refreshBtn" title="re-fetch hosts and image list"
          onClick={() => store.actions.ui.refresh()}
        >Refresh</button>
        <button
          id="unhideBtn" title="temporarily show thumbed-down images (votes are kept)"
          onClick={() => store.actions.judgments.toggleReveal()}
        >Unhide</button>
        <button
          id="hideUpBtn" title="hide thumbed-up images for this session (reload restores)"
          onClick={() => store.actions.judgments.toggleHideUp()}
        >Hide up-voted</button>
      </span>
      <span class="flexspacer" />
      <InfoLayoutSwitcher />
      <a
        id="dlFeedback"
        class="btn"
        href="/api/feedback"
        download="kosmozoo_feedback.json"
        title="download the exact feedback.json as stored on the server"
      >Download feedback</a>
      <div id="menuWrap" ref={menuWrapRef}>
        <button
          id="menuBtn"
          title="options"
          onClick={(e) => { e.stopPropagation(); store.actions.ui.toggleMenu(); }}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 6h16" />
            <path d="M4 12h16" />
            <path d="M4 18h16" />
          </svg>
        </button>
        <div id="menu" hidden={!store.state.menuOpen()} />
      </div>
    </header>
  );
}
