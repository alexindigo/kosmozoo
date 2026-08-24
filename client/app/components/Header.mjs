// client/app/components/Header.mjs — the top chrome, declared.
//
// Composes <HostPicker>, the registry-driven header buttons, the axes status,
// and the options menu. Reads the chrome registries (js/chrome.mjs) and
// re-renders on the shared render() fan-out via useVersion.

import { h } from "../../vendor/preact/vendor.mjs";
import { useRef, useEffect } from "../../vendor/preact/vendor.mjs";
import { state, render } from "../../js/state.mjs";
import { headerButtonsList, menuItemsList, toggleMenu } from "../../js/chrome.mjs";
import { axisStatus } from "../../js/axes.mjs";
import { rebuildFeed } from "../services/feedView.mjs";
import { useVersion } from "../hooks/useVersion.mjs";
import { HostPicker } from "./HostPicker.mjs";

const MENU_BTN_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h16" /></svg>';

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
  useVersion();
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
    h("span", { id: "status" }, axisStatus()),
    h("span", { class: "flexspacer" }),
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
