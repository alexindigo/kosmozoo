// client-solid/components/Header.tsx — the top chrome, declarative.
//
// Logo/title, host picker, filter box, options button, the menu with its
// settings rows, and the layout switcher.

import { For, Show } from "solid-js/web";
import { iconSvg } from "/js/icons.mjs";
import { useAppStore } from "../store/app-store.js";
import { useClickOutside } from "../lib/click-outside.js";
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
    return store.state.currentNodeImages().length > 0;
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

// The options menu, declarative: scraper toggle + pause, the fields picker,
// the judgment coupling, the delete mode. The filter input narrows the rows
// (label/search text).
function Menu() {
  const store = useAppStore();
  const open = () => store.state.menuOpen();
  const q = () => (store.state.menuFilter() ?? "").toLowerCase();
  const matches = (hay) => !q() || hay.toLowerCase().includes(q());
  const scraperPending = () => {
    const p = store.state.scraper?.pending ?? {};
    const total = Object.values(p).reduce((a, b) => a + b, 0);
    return total > 0 ? `${total} left` : "";
  };
  return (
    <Show when={open()}>
      <div id="menu">
        <input
          id="menuSearch" type="search" placeholder="filter settings…" spellcheck={false}
          value={store.state.menuFilter()}
          onInput={(e) => store.actions.menu.setFilter(e.target.value)}
        />
        <div id="menuRows">
          <Show when={matches("metadata scan")}>
            <div class="menurow">
              <label class="switchwrap" title="walk the host's image list and extract PNG-embedded metadata in the background">
                <input
                  type="checkbox" checked={!!store.state.scraper?.enabled}
                  onChange={(e) => store.actions.menu.scraperToggle(e.target.checked)}
                />
                <span class="track" />
                metadata scan
              </label>
              <button
                id="scraperPause" title="pause/resume the background scan (laptop mode)"
                onClick={() => store.actions.menu.scraperPause()}
                innerHTML={iconSvg(store.state.scraper?.paused ? "player-play" : "player-pause", 12)}
              />
              <span id="scraperPending" class="menuextra">{scraperPending()}</span>
            </div>
          </Show>
          <Show when={matches("down-vote hides")}>
            <div class="menurow">
              <label class="switchwrap" title="thumbs-down removes an image from view (reveal with the Unhide button)">
                <input
                  type="checkbox" checked={store.state.judgmentPrefs.downvoteHides}
                  onChange={(e) => store.actions.judgments.setDownvoteHides(e.target.checked)}
                />
                <span class="track" />
                down-vote hides
              </label>
            </div>
          </Show>
          <Show when={matches("trash-delete via assets_plus")}>
            <div class="menurow">
              <label class="switchwrap" title="delete from Comfy hosts through the assets_plus extension (recoverable trash); off falls back to hiding the image">
                <input
                  type="checkbox" checked={store.state.deletePrefs.useAssetsPlus}
                  onChange={(e) => store.actions.menu.deleteAssetsPlus(e.target.checked)}
                />
                <span class="track" />
                trash-delete via assets_plus
              </label>
            </div>
          </Show>
          <Show when={matches("download feedback")}>
            <div class="menurow">
              <div class="menulabel">judgments</div>
              <a
                class="btn"
                href={`/api/collections/${encodeURIComponent(store.state.host())}/feedback.json`}
                download={`kosmozoo_${store.state.host()}_feedback.json`}
                title="download this collection's judgments (generated on demand)"
              >download feedback.json</a>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}

export function Header() {
  const store = useAppStore();
  let menuWrapRef;

  // click outside the menu closes it — the shared primitive; the wrapper
  // contains the button, so no stopPropagation shield is needed
  useClickOutside(() => menuWrapRef, () => {
    if (store.state.menuOpen()) store.actions.ui.closeMenu();
  });

  return (
    <header id="chrome">
      <img class="logo" src="/logo-64.png" alt="kosmozoo" width={24} height={24} />
      <h1>Kosmozoo</h1>
      <HostPicker />
      <input
        id="filter"
        type="search"
        placeholder="filter filenames…"
        spellcheck={false}
        value={store.state.filter()}
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
        <div id="menuWrap" ref={menuWrapRef}>
          <button
            id="menuBtn"
            title="options"
            onClick={() => store.actions.ui.toggleMenu()}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 6h16" />
              <path d="M4 12h16" />
              <path d="M4 18h16" />
            </svg>
          </button>
          <Menu />
        </div>
    </header>
  );
}
