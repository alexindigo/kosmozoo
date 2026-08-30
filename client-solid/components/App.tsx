// client-solid/components/App.tsx — the Solid root component.
//
// Phase 1 shell: header + the main split (candidates column with the grid
// the feed phase fills, divider) + the status stack. The workspace pane/bar,
// overlays and the rest land with their phases.

import { Header } from "./Header.js";

export function App() {
  return (
    <>
      <Header />
      <main>
        <section id="candidatesCol">
          <div id="grid" />
        </section>
        <div id="divider" title="drag to resize the split" />
      </main>
      <div id="statusStack" />
    </>
  );
}
