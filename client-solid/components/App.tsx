// client-solid/components/App.tsx — the Solid root component.
//
// Phase 6 shell: every surface is a component — header + bulk bar, the main
// split (feed rail, candidates column with the virtualized feed, divider,
// workspace pane + bar), status stack, scroll-top button, workbench stage,
// variations portal, delete confirmation, and the overlays (fields picker,
// anchor info, keys panel).

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
      <StatusStack />
      <ScrollTopButton />
      <DiffStage />
      <FeatureModals />
      <ConfirmDelete />
      <InfoOverlay />
      <KeysPanel />
    </>
  );
}
