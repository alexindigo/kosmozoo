// client/app/components/WorkspacePane.mjs — the right-column workspace.
//
// Two spaces share the pane: the metadata details of the current image and the
// anchors feed. state.workspace picks which is shown. The details body reads
// state.current (the single current-image pointer) — hidden included.

import { h, render as preactRender } from "../../vendor/preact/vendor.mjs";
import { useRef, useEffect } from "../../vendor/preact/vendor.mjs";
import { state } from "../../js/state.mjs";
import { buildMetaBody, nodeImages } from "../../js/fields.mjs";
import { AnchorSpace } from "./AnchorSpace.mjs";
import { Zoomable } from "./Zoomable.mjs";
import { fmtBytes } from "./MetaBar.mjs";
import { api } from "../../js/api.mjs";

// the current image (host/folder image or anchor)
function detailsImage() {
  const c = state.current;
  if (!c) return null;
  if (c.remote === "anchor") {
    return state.anchors.find((a) => a.name === c.image) ?? null;
  }
  return state.images.find((i) => i.host === c.remote &&
    (i.filename === c.image || i.filename === c.remote + "#" + c.image)) ?? null;
}

function DetailsBody() {
  const ref = useRef(null);
  const img = detailsImage();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = "";
    if (!img) {
      const p = document.createElement("div");
      p.className = "info-none";
      p.textContent = "No image selected.";
      el.appendChild(p);
      return;
    }
    const head = document.createElement("div");
    head.className = "ws-head";
    const name = document.createElement("div");
    name.className = "ws-name";
    name.textContent = img.filename ?? img.name ?? "";
    name.title = img.filename ?? img.name ?? "";
    const sub = document.createElement("div");
    sub.className = "ws-sub";
    // dimensions + file size — the host identity is noise here
    const subText = () => {
      const bits = [];
      if (img.meta?.width && img.meta?.height) bits.push(`${img.meta.width}×${img.meta.height}px`);
      const sz = img.size != null ? fmtBytes(img.size) : null;
      if (sz) bits.push(sz);
      return bits.length ? bits.join(" · ") : (img.host ? "" : "local anchor");
    };
    sub.textContent = subText();
    head.append(name, sub);
    if (img.host && img.size == null) {
      // the card's HEAD fetch may not have run — fill the size in place
      fetch(api.imageBytesUrl(img.id), { method: "HEAD" }).then((r) => {
        const cl = r.headers.get("content-length");
        if (r.ok && cl) {
          img.size = Number(cl);
          sub.textContent = subText();
        }
      }).catch(() => {});
    }

    // discovered node images get their own column beside the text fields —
    // the layout (side-by-side / mirrored / stacked) follows state.infoLayout.
    // Anchors carry no host, so their refs can't resolve — single column.
    // The name/host header belongs to the text half of the split.
    const images = img.host ? nodeImages(img.meta ?? null, img.host) : [];
    if (images.length) {
      const cols = document.createElement("div");
      cols.className = "ws-cols " + (state.infoLayout === "rev" ? "rev"
        : state.infoLayout === "stacked" ? "stacked" : "split");
      const imgCol = document.createElement("div");
      imgCol.className = "ws-imgcol";
      for (const image of images) {
        const sec = document.createElement("div");
        sec.className = "infoimg";
        sec.dataset.file = image.file;
        // same treatment as feed and anchor images: Ctrl+wheel zoom toward
        // the cursor, drag pans while zoomed, double-click resets; the view
        // persists per input file. Imperative render — this block builds
        // its DOM by hand; the boxes die with the effect's innerHTML wipe.
        const box = document.createElement("div");
        preactRender(h(Zoomable, {
          src: image.src,
          alt: image.file,
          zoomKey: `input:${img.host}:${image.file}`,
        }), box);
        sec.append(box);
        imgCol.appendChild(sec);
      }
      const txtCol = document.createElement("div");
      txtCol.className = "ws-txtcol";
      txtCol.appendChild(head);
      txtCol.appendChild(buildMetaBody(img.meta ?? null, img.host, { skipImages: true }));
      // filename links in the text re-focus the images column on that image
      txtCol.addEventListener("click", (e) => {
        const ref = e.target.closest(".imgref[data-file]");
        if (!ref) return;
        const target = imgCol.querySelector(`.infoimg[data-file="${CSS.escape(ref.dataset.file)}"]`);
        if (!target) return;
        target.scrollIntoView({ behavior: "smooth", block: "nearest" });
        target.classList.add("flash");
        setTimeout(() => target.classList.remove("flash"), 1200);
      });
      cols.append(imgCol, txtCol);
      el.appendChild(cols);
    } else {
      el.appendChild(head);
      el.appendChild(buildMetaBody(img.meta ?? null, img.host));
    }
  }, [img, state.infoLayout]);
  return h("div", { id: "wsDetailsBody", class: "metabody", ref });
}

export function WorkspacePane() {
  return h("aside", { id: "workspace" },
    h("div", { id: "wsDetails", class: "ws-space", hidden: state.workspace !== "details" },
      h(DetailsBody, null),
    ),
    h("div", { id: "wsAnchors", class: "ws-space", hidden: state.workspace !== "anchors" },
      h(AnchorSpace, null),
    ),
  );
}
