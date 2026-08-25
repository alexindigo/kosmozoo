// client/app/components/App.mjs — the Preact root component.
//
// <App> owns the whole body: every surface is a component. The imperative
// engines (feed, lightbox, diff) keep their async image work and write
// src/style/dataset directly on elements the components render — never
// attributes the vdom declares, so re-renders and engines don't collide.

import { h, Fragment, useEffect } from "../../vendor/preact/vendor.mjs";
import { loadBootData } from "../services/bootData.mjs";
import { startScraperPoll } from "../services/scraper.mjs";
import { Header } from "./Header.mjs";
import { WorkspacePane } from "./WorkspacePane.mjs";
import { WorkspaceBar } from "./WorkspaceBar.mjs";
import { FieldsOverlay } from "./FieldsOverlay.mjs";
import { InfoOverlay } from "./InfoOverlay.mjs";
import { KeysPanel } from "./KeysPanel.mjs";
import { Lightbox } from "./Lightbox.mjs";
import { DiffStage } from "./DiffStage.mjs";

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
    h(Lightbox, null),
    h(DiffStage, null),
  );
}
