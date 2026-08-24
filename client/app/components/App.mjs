// client/app/components/App.mjs — the Preact root component.
//
// Phase 1: a dummy shell that proves the mount. The legacy chrome
// (client/js) still renders the entire app; this node only confirms Preact is
// live. Later phases grow <App> into the whole surface, one area at a time.

import { h } from "../../vendor/preact/vendor.mjs";

export function App() {
  return h("span", { class: "preact-shell", hidden: true }, "kosmozoo preact shell");
}
