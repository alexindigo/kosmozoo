// client-solid/components/App.tsx — the Solid root component.
//
// Phase 3 shell: header + the main split (candidates column with the
// virtualized feed, divider, workspace pane + bar) + the status stack + the
// delete confirmation. Overlays and the rest land with their phases.

import { Header } from "./Header.js";
import { Grid } from "./Grid.js";
import { WorkspacePane } from "./WorkspacePane.js";
import { WorkspaceBar } from "./WorkspaceBar.js";
import { ConfirmDelete } from "./ConfirmDelete.js";

export function App() {
  return (
    <>
      <Header />
      <main>
        <section id="candidatesCol">
          <div id="grid">
            <Grid />
          </div>
        </section>
        <div id="divider" title="drag to resize the split" />
        <WorkspacePane />
        <WorkspaceBar />
      </main>
      <div id="statusStack" />
      <ConfirmDelete />
    </>
  );
}
