// client-solid/components/App.tsx — the Solid root component.
//
// Phase 2 shell: header + the main split (candidates column with the
// virtualized feed, divider) + the status stack + the delete confirmation.
// The workspace pane/bar, overlays and the rest land with their phases.

import { Header } from "./Header.js";
import { Grid } from "./Grid.js";
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
      </main>
      <div id="statusStack" />
      <ConfirmDelete />
    </>
  );
}
