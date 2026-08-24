// client/app/components/App.mjs — the Preact root component.
//
// Single-growing-tree approach: <App> owns the whole body. Surfaces that are
// not yet components render as constant dangerouslySetInnerHTML passthrough
// (see ../skeleton.mjs) — Preact diffs them vdom-to-vdom as "unchanged" and
// never touches what the legacy modules write inside. Each passthrough is
// replaced by a real component in its phase.

import { h, Fragment, useEffect } from "../../vendor/preact/vendor.mjs";
import { loadBootData } from "../services/bootData.mjs";
import { startScraperPoll } from "../services/scraper.mjs";
import {
  CHROME_INNER,
  MAIN_INNER,
  FIELDS_INNER,
  INFO_INNER,
  KEYS_INNER,
  LIGHTBOX_INNER,
  DIFF_INNER,
} from "../skeleton.mjs";

export function App() {
  useEffect(() => {
    // The legacy boot surfaces a load failure in the status line; swallow it
    // here so this effect never leaves an unhandled rejection.
    loadBootData().catch(() => {});
    startScraperPoll();
  }, []);

  return h(Fragment, null,
    h("header", { id: "chrome", dangerouslySetInnerHTML: { __html: CHROME_INNER } }),
    h("main", { dangerouslySetInnerHTML: { __html: MAIN_INNER } }),
    h("div", { id: "statusStack", dangerouslySetInnerHTML: { __html: "" } }),
    h("div", { id: "fieldsOverlay", hidden: true, dangerouslySetInnerHTML: { __html: FIELDS_INNER } }),
    h("div", { id: "infoOverlay", hidden: true, dangerouslySetInnerHTML: { __html: INFO_INNER } }),
    h("div", { id: "keysPanel", hidden: true, dangerouslySetInnerHTML: { __html: KEYS_INNER } }),
    h("div", { id: "lightbox", hidden: true, dangerouslySetInnerHTML: { __html: LIGHTBOX_INNER } }),
    h("div", { id: "diff", hidden: true, dangerouslySetInnerHTML: { __html: DIFF_INNER } }),
  );
}
