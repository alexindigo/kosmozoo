// client-solid/components/Header.tsx — the top chrome, declarative.
//
// Phase 1 shape: logo/title, host picker, filter box, download-feedback link,
// options button. #headerButtons and the menu rows fill in as their features
// land (feed/judgment buttons phase 2, menu items with the settings surfaces).
// The layout switcher appears with the details pane (phase 3).

import { onCleanup } from "solid-js";
import { useAppStore } from "../store/app-store.js";
import { HostPicker } from "./HostPicker.js";

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
      <span id="headerButtons" />
      <span class="flexspacer" />
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
