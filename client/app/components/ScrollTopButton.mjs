// client/app/components/ScrollTopButton.mjs — a floating up-arrow in the
// bottom-left corner. Visible when the current image is not the feed's
// topmost card; clicking scrolls the feed back to the top.

import { h, useEffect, useState } from "../../vendor/preact/vendor.mjs";
import { state } from "../../js/state.mjs";
import { subscribe } from "../services/notify.mjs";
import { matchesFile } from "../../js/route.mjs";
import { viewIndices } from "../../js/feed.mjs";
import { suppressScrollSnap } from "../services/scrollSnap.mjs";

const UP_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5" /><path d="M5 12l7-7 7 7" /></svg>';

export function ScrollTopButton() {
  const [, setVersion] = useState(0);
  useEffect(() => subscribe(() => setVersion((v) => v + 1)), []);

  const view = viewIndices();
  const cur = state.current;
  const topImage = view.length ? state.images[view[0]] : null;
  const isTop = cur && topImage
    && cur.remote === state.host
    && matchesFile(topImage, state.host, cur.image);
  const visible = !!(cur && topImage && !isTop && !state.diff.open);

  if (!visible) return null;

  const scrollTop = () => {
    const col = document.getElementById("candidatesCol");
    if (!col) return;
    suppressScrollSnap();
    col.scrollTo({ top: 0, behavior: "smooth" });
  };

  return h("button", {
    id: "scrollTopBtn",
    title: "back to top",
    onClick: scrollTop,
    dangerouslySetInnerHTML: { __html: UP_SVG },
  });
}
