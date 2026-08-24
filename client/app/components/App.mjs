// client/app/components/App.mjs — the Preact root component.
//
// Phase 2: still a dummy shell for the visible surface (the legacy chrome in
// client/js renders the app), but now the owner of the boot side-effects — it
// loads the boot data and starts the scraper poll once. The legacy boot awaits
// the same memoized boot-data promise before it picks the initial host.

import { h, useEffect } from "../../vendor/preact/vendor.mjs";
import { loadBootData } from "../services/bootData.mjs";
import { startScraperPoll } from "../services/scraper.mjs";

export function App() {
  useEffect(() => {
    // The legacy boot surfaces a load failure in the status line; swallow it
    // here so this effect never leaves an unhandled rejection.
    loadBootData().catch(() => {});
    startScraperPoll();
  }, []);
  return h("span", { class: "preact-shell", hidden: true }, "kosmozoo preact shell");
}
