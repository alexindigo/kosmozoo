// client/app/main.mjs — the Preact entrypoint. Mounts <App> into #app.
//
// During the migration the legacy chrome (js/main.mjs) still boots and renders
// the app; this shell grows into the whole surface one phase at a time, until
// it becomes the sole entrypoint.

import { h, render } from "../vendor/preact/vendor.mjs";
import { App } from "./components/App.mjs";

render(h(App, null), document.getElementById("app"));
