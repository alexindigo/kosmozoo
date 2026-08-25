// client/app/components/FieldsOverlay.mjs — the metadata fields picker.
// Per-field card/strip toggles plus per-group masters, all controlled by
// state.fieldsCfg; a change persists and fires the injected onChanged hook
// (the cards' meta refresh). Master↔per-field sync falls out of re-render.

import { h } from "../../vendor/preact/vendor.mjs";
import { state } from "../../js/state.mjs";
import { render } from "../services/notify.mjs";
import { META_FIELD_GROUPS, persist, notifyFieldsChanged } from "../../js/fields.mjs";
import { Modal } from "./Modal.mjs";

const CLOSE_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6l-12 12" /><path d="M6 6l12 12" /></svg>';

const FIELDS_SUB = '<b>under image</b> — the card\'s metadata panel · <b>strip</b> — a semi-transparent strip over the image bottom (cards) / screen bottom (lightbox)';

async function applyChange() {
  await persist();
  render();
  notifyFieldsChanged();
}

function fieldToggle(field, col) {
  return h("label", { class: "switchwrap mini" },
    h("input", {
      type: "checkbox",
      checked: !!state.fieldsCfg[field][col],
      "data-field": field,
      "data-col": col,
      onChange: async (e) => {
        state.fieldsCfg[field][col] = e.target.checked;
        await applyChange();
      },
    }),
    h("span", { class: "track" }),
  );
}

function masterToggle(gname, fields, col) {
  return h("label", {
    class: "switchwrap mini",
    title: `toggle all ${gname} (${col === "card" ? "under image" : "strip"})`,
  },
    h("input", {
      type: "checkbox",
      checked: fields.some(([n]) => state.fieldsCfg[n][col]),
      "data-col": col,
      onChange: async (e) => {
        for (const [n] of fields) state.fieldsCfg[n][col] = e.target.checked;
        await applyChange();
      },
    }),
    h("span", { class: "track" }),
  );
}

export function FieldsOverlay() {
  const close = () => { state.fieldsOverlayOpen = false; render(); };

  const tbl = [];
  if (state.fieldsCfg) { // null until boot data lands; the overlay renders hidden
    tbl.push(h("div", {
      class: "frow head", key: "head",
      dangerouslySetInnerHTML: { __html: '<span class="fname2">field (grouped by node)</span><span>under image</span><span>strip</span>' },
    }));
    for (const [gname, fields] of META_FIELD_GROUPS) {
      tbl.push(h("div", { class: "fgroup", key: gname },
        h("div", { class: "fgrouphead" },
          h("span", { class: "gname" }, gname),
          masterToggle(gname, fields, "card"),
          masterToggle(gname, fields, "strip"),
        ),
        h("div", { class: "fgroupbody", "data-group": gname },
          fields.map(([name]) => h("div", { class: "frow", key: name },
            h("span", { class: "fname2" }, name),
            fieldToggle(name, "card"),
            fieldToggle(name, "strip"),
          )),
        ),
      ));
    }
  }

  return h(Modal, { overlayId: "fieldsOverlay", panelId: "fieldsPanel", open: state.fieldsOverlayOpen, onClose: close },
    h("button", {
      id: "fieldsClose", title: "close (Esc)", onClick: close,
      dangerouslySetInnerHTML: { __html: CLOSE_SVG },
    }),
    h("div", { id: "fieldsTitle" }, "Metadata fields"),
    h("div", { id: "fieldsSub", dangerouslySetInnerHTML: { __html: FIELDS_SUB } }),
    h("div", { id: "fieldsTable" }, tbl),
  );
}
