// client/app/components/App.mjs — the Preact root component.
//
// Single-growing-tree approach: <App> owns the whole body. Surfaces that are
// not yet components render as constant dangerouslySetInnerHTML passthrough
// (see ../skeleton.mjs) — Preact diffs them vdom-to-vdom as "unchanged" and
// never touches what the legacy modules write inside. Each passthrough is
// replaced by a real component in its phase.

import { h, Fragment, useEffect } from "../../vendor/preact/vendor.mjs";
import { loadBootData } from "../services/bootData.mjs";
import { startScraperPoll } from "../services/scraper.mjs";
import {
  LIGHTBOX_INNER,
  DIFF_INNER,
} from "../skeleton.mjs";
import { Header } from "./Header.mjs";
import { WorkspacePane } from "./WorkspacePane.mjs";
import { WorkspaceBar } from "./WorkspaceBar.mjs";
import { FieldsOverlay } from "./FieldsOverlay.mjs";
import { InfoOverlay } from "./InfoOverlay.mjs";
import { KeysPanel } from "./KeysPanel.mjs";

export function App() {
  useEffect(() => {
    // The legacy boot surfaces a load failure in the status line; swallow it
    // here so this effect never leaves an unhandled rejection.
    loadBootData().catch(() => {});
    startScraperPoll();
  }, []);

  return h(Fragment, null,
    h(Header, null),
    h("main", null,
      h("section", { id: "candidatesCol" }, h("div", { id: "grid" })),
      h("div", { id: "divider", title: "drag to resize the split" }),
      h(WorkspacePane, null),
      h(WorkspaceBar, null),
    ),
    h("div", { id: "statusStack", dangerouslySetInnerHTML: { __html: "" } }),
    h(FieldsOverlay, null),
    h(InfoOverlay, null),
    h(KeysPanel, null),
    h("div", { id: "lightbox", hidden: true, dangerouslySetInnerHTML: { __html: LIGHTBOX_INNER } }),
    h("div", { id: "diff", hidden: true, dangerouslySetInnerHTML: { __html: DIFF_INNER } }),
  );
}
