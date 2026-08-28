// client/app/components/Header.mjs — the top chrome, declared.
//
// Composes <HostPicker>, the registry-driven header buttons, and the options
// menu. Reads the chrome registries (js/chrome.mjs) and re-renders when <App>
// re-renders on the shared render() signal.

import { h } from "../../vendor/preact/vendor.mjs";
import { useRef, useEffect } from "../../vendor/preact/vendor.mjs";
import { state } from "../../js/state.mjs";
import { render } from "../services/notify.mjs";
import { headerButtonsList, menuItemsList, toggleMenu } from "../../js/chrome.mjs";
import { rebuildFeed } from "../services/feedView.mjs";
import { setInfoLayout } from "../services/workspaceState.mjs";
import { matchesFile } from "../../js/route.mjs";
import { nodeImages } from "../../js/fields.mjs";
import { HostPicker } from "./HostPicker.mjs";

const MENU_BTN_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h16" /></svg>';

// layout-switcher icons: a square with one divider — vertical right of
// center (wide images / narrow text), horizontal (stacked), vertical left
// of center (narrow text / wide images)
const LAYOUT_SPLIT_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" /></svg>';
const LAYOUT_STACKED_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="3" y1="15" x2="21" y2="15" /></svg>';
const LAYOUT_REV_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" /></svg>';

// the layout switcher applies to the details pane's current image: shown
// only when the details space is on and that image's graph references
// discovered input images.
function infoLayoutApplicable() {
  if (state.workspace !== "details") return false;
  const c = state.current;
  if (!c || c.remote === "anchor") return false;
  const img = state.images.find((i) => i.host === c.remote &&
    (i.filename === c.image || i.filename === c.remote + "#" + c.image));
  return !!(img?.host && nodeImages(img.meta, img.host).length);
}

function InfoLayoutSwitcher() {
  if (!infoLayoutApplicable()) return null;
  const modes = [
    ["split", LAYOUT_SPLIT_SVG, "images left / metadata right"],
    ["stacked", LAYOUT_STACKED_SVG, "images above / metadata below"],
    ["rev", LAYOUT_REV_SVG, "metadata left / images right"],
  ];
  return h("span", { id: "infoLayout" },
    modes.map(([mode, svg, title]) =>
      h("button", {
        key: mode,
        class: state.infoLayout === mode ? "on" : "",
        title: "info layout: " + title,
        onClick: () => setInfoLayout(mode),
        dangerouslySetInnerHTML: { __html: svg },
      })
    ),
  );
}

// A "custom" menu row hands its DOM to the registry item's imperative render —
// rebuilt on every render while open, exactly like the outgoing menu did.
function CustomRow({ item }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.innerHTML = "";
      item.render(ref.current);
    }
  });
  return h("div", { class: "menurow", ref });
}

function MenuRow({ item }) {
  if (item.kind === "toggle") {
    return h("div", { class: "menurow" },
      h("label", { class: "switchwrap", title: item.title },
        h("input", {
          type: "checkbox",
          checked: !!item.get(),
          onChange: async (e) => { await item.set(e.target.checked); render(); },
        }),
        h("span", { class: "track" }),
        item.label,
      ),
    );
  }
  if (item.kind === "action") {
    return h("div", { class: "menurow" },
      h("button", { onClick: item.onClick }, item.label),
    );
  }
  return h(CustomRow, { item });
}

function Menu() {
  const open = state.menuOpen;
  const q = (state.menuFilter ?? "").toLowerCase();
  return h("div", { id: "menu", hidden: !open },
    open
      ? [
          h("input", {
            key: "search",
            id: "menuSearch",
            type: "search",
            placeholder: "filter settings…",
            spellcheck: false,
            value: state.menuFilter ?? "",
            onInput: (e) => { state.menuFilter = e.target.value; render(); },
          }),
          h("div", { key: "rows", id: "menuRows" },
            menuItemsList()
              .filter((item) => {
                const hay = (item.label ?? item.searchText ?? item.id).toLowerCase();
                return !q || hay.includes(q);
              })
              .map((item) => h(MenuRow, { key: item.id, item })),
          ),
        ]
      : null,
  );
}

export function Header() {
  const menuWrapRef = useRef(null);

  // click outside the menu closes it (menuBtn's own click stops propagation)
  useEffect(() => {
    const onDocClick = (e) => {
      if (state.menuOpen && menuWrapRef.current && !menuWrapRef.current.contains(e.target)) {
        state.menuOpen = false;
        render();
      }
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, []);

  return h("header", { id: "chrome" },
    h("img", { src: "/logo-64.png", alt: "kosmozoo", width: 24, height: 24, style: "border-radius:6px" }),
    h("h1", null, "Kosmozoo"),
    h(HostPicker, null),
    h("input", {
      id: "filter",
      type: "search",
      placeholder: "filter filenames…",
      spellcheck: false,
      onInput: (e) => { state.filter = e.target.value; rebuildFeed(); },
    }),
    h("span", { id: "headerButtons" },
      headerButtonsList().map((b) =>
        h("button", { key: b.id, id: b.id, title: b.title, onClick: b.onClick }, b.label)
      ),
    ),
    h("span", { class: "flexspacer" }),
    h(InfoLayoutSwitcher, null),
    h("a", {
      id: "dlFeedback",
      class: "btn",
      href: "/api/feedback",
      download: "kosmozoo_feedback.json",
      title: "download the exact feedback.json as stored on the server",
    }, "Download feedback"),
    h("div", { id: "menuWrap", ref: menuWrapRef },
      h("button", {
        id: "menuBtn",
        title: "options",
        onClick: (e) => { e.stopPropagation(); toggleMenu(); },
        dangerouslySetInnerHTML: { __html: MENU_BTN_SVG },
      }),
      h(Menu, null),
    ),
  );
}
