// client/app/components/App.mjs — the Preact root component.
//
// <App> owns the whole body: every surface is a component. The imperative
// engines (feed, lightbox, diff) keep their async image work and write
// src/style/dataset directly on elements the components render — never
// attributes the vdom declares, so re-renders and engines don't collide.
//
// The bridge snapshot lives here: render() (app/services/notify.mjs) bumps
// one version, and the whole tree re-renders. <Grid> — a root of its own
// inside #grid — subscribes separately.

import { h, Fragment, useEffect, useState } from "../../vendor/preact/vendor.mjs";
import { state } from "../../js/state.mjs";
import { render, subscribe } from "../services/notify.mjs";
import { setRoi } from "../../js/roi.mjs";
import { addAnchorFiles } from "../../js/anchors.mjs";
import { chrome } from "../../js/chrome.mjs";
import { openDiff } from "../../js/diff.mjs";
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
import { ConfirmDelete } from "./ConfirmDelete.mjs";

// public namespace: e2e (and the console) drive the same state the keys do
window.kosmozoo = { state, render, setRoi, addAnchorFiles, chrome, openDiff };

export function App() {
  const [, setVersion] = useState(0);
  useEffect(() => subscribe(() => setVersion((v) => v + 1)), []);

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
    h(ConfirmDelete, null),
  );
}
