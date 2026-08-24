// client/app/components/MetaBar.mjs — the collapsed params line under a card:
// pixel size + on-disk size, an expand toggle, and the full fields-config
// panel inside (hidden until expanded). facts fill in as they arrive.

import { h } from "../../vendor/preact/vendor.mjs";
import { useRef, useEffect } from "../../vendor/preact/vendor.mjs";
import { fillCardMeta } from "../../js/fields.mjs";
import { iconSvg } from "../../js/icons.mjs";

function fmtBytes(n) {
  if (n == null) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function metaBarText(f) {
  const bits = [];
  if (f.w && f.h) bits.push(`${f.w}×${f.h}px`);
  const sz = fmtBytes(f.bytes);
  if (sz) bits.push(sz);
  return bits.length ? bits.join(" · ") : "no metadata yet";
}

export function MetaBar({ facts, meta, expanded, onToggle }) {
  const propsRef = useRef(null);
  const descRef = useRef(null);
  useEffect(() => {
    if (propsRef.current && descRef.current) fillCardMeta(propsRef.current, descRef.current, meta);
  }, [meta]);
  const text = metaBarText(facts);
  return h("div", { class: "metabar" + (expanded ? " open" : "") },
    h("span", { class: "metabar-info", title: text }, text),
    h("button", {
      class: "metabar-toggle",
      title: expanded ? "hide parameters" : "show parameters",
      onClick: (e) => { e.stopPropagation(); onToggle(); },
      dangerouslySetInnerHTML: { __html: iconSvg("chevron-down", 14) },
    }),
    h("div", { class: "pair metabar-full", hidden: !expanded },
      h("div", { class: "props", ref: propsRef }),
      h("div", { class: "desc", ref: descRef }),
    ),
  );
}
