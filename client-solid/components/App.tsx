// client-solid/components/App.tsx — the Solid root component.
//
// Every surface is a component — header + bulk bar, the main split (feed
// rail, candidates column with the virtualized feed, divider, workspace
// pane + bar), status stack, scroll-top button, workbench stage, feature
// modals, delete confirmation, and the overlays (anchor info, keys panel).

import { createEffect } from "solid-js";
import { useAppStore } from "../store/app-store.js";
import { Header } from "./Header.js";
import { BulkBar } from "./BulkBar.js";
import { FeedRail } from "./FeedRail.js";
import { Grid } from "./Grid.js";
import { WorkspacePane } from "./WorkspacePane.js";
import { WorkspaceBar } from "./WorkspaceBar.js";
import { StatusStack } from "./StatusStack.js";
import { ScrollTopButton } from "./ScrollTopButton.js";
import { DiffStage } from "./DiffStage.js";
import { ConfirmDelete } from "./ConfirmDelete.js";
import { InfoOverlay } from "./InfoOverlay.js";
import { KeysPanel } from "./KeysPanel.js";
import { FeatureModals } from "../features/index.js";

export function App() {
  const store = useAppStore();
  // the shared resizing cursor: ONE body-class writer, driven by the store
  // signal the drag primitive's consumers set (G8)
  createEffect(() => document.body.classList.toggle("resizing", store.state.resizing()));
  return (
    <>
      <Header />
      <BulkBar />
      <main>
        <FeedRail />
        <Grid />
        <WorkspacePane />
        <WorkspaceBar />
      </main>
      <div id="statusCol">
        <ScrollTopButton />
        <StatusStack />
      </div>
      <DiffStage />
      <FeatureModals />
      <ConfirmDelete />
      <InfoOverlay />
      <KeysPanel />
    </>
  );
}
