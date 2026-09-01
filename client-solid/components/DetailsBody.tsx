// client-solid/components/DetailsBody.tsx — the current image's metadata
// details, declarative (the outgoing WorkspacePane built this DOM by hand
// inside an effect).
//
// Reads the store's current pointer (hidden images included). Field values
// that differ from the previous current image (stack top) render .pdiff.
// Discovered node images get their own column beside the text fields — the
// layout follows store.state.infoLayout. Filename links in the text column
// re-focus the images column on that image.

import { createEffect, createMemo, For, Show } from "solid-js";
import { useAppStore } from "../store/app-store.js";
import { nodeImages } from "../store/fields.js";
import { fmtBytes } from "./MetaBar.js";
import { MetaBody } from "./MetaBody.js";
import { Zoomable } from "./Zoomable.js";

// a { remote, image } pointer → its feed entry (anchors land in phase 6)
function imageFor(store, c) {
  if (!c || c.remote === "anchor") return null;
  return store.state.images.find((i) => i.host === c.remote &&
    (i.filename === c.image || i.filename === c.remote + "#" + c.image)) ?? null;
}

export function DetailsBody() {
  const store = useAppStore();
  const img = createMemo(() => imageFor(store, store.state.current()));
  const compareMeta = createMemo(() => imageFor(store, store.state.currentStack().at(-1) ?? null)?.meta ?? null);
  const images = () => {
    const im = img();
    return im?.host ? nodeImages(im.meta ?? null, im.host) : [];
  };
  const colsClass = () => {
    const l = store.state.infoLayout();
    return "info " + (l === "rev" ? "rev" : l === "stacked" ? "stacked" : "split");
  };

  // the card's HEAD fetch may not have run — fill the size in place
  createEffect(() => {
    const im = img();
    if (im?.host && im.size == null) store.actions.images.fillSize(im.id);
  });

  // filename links in the text column focus the images column on that image
  const onTxtClick = (e) => {
    const refEl = e.target.closest?.(".imgref[data-file]");
    if (!refEl) return;
    const cols = refEl.closest(".info");
    const target = cols?.querySelector(`.infoimg[data-file="${CSS.escape(refEl.dataset.file)}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "nearest" });
    target.classList.add("flash");
    setTimeout(() => target.classList.remove("flash"), 1200);
  };

  const split = () => store.ui.info?.split ?? 0.66;
  const onSplitDown = (e) => {
    e.preventDefault();
    const sep = e.currentTarget;
    sep.setPointerCapture(e.pointerId);
    const box = sep.parentElement.getBoundingClientRect();
    const vertical = sep.parentElement.classList.contains("stacked");
    const move = (ev) => {
      const pos = vertical ? (ev.clientY - box.top) / box.height
        : (ev.clientX - box.left) / box.width;
      store.actions.ui.info.split.set(pos);
    };
    const up = () => {
      sep.removeEventListener("pointermove", move);
      sep.removeEventListener("pointerup", up);
    };
    sep.addEventListener("pointermove", move);
    sep.addEventListener("pointerup", up);
  };

  return (
    <div class="info-body">
      <Show when={img()} fallback={<div class="info-none">No image selected.</div>}>
        {(im) => (
          <Show
            when={im.meta || im.extracted !== false}
            fallback={<div class="info-none">loading metadata…</div>}
          >
            <Show
              when={images().length > 0}
              fallback={
                <>
                  <Head im={im} />
                  <MetaBody meta={im.meta ?? null} host={im.host} compareMeta={compareMeta()} />
                </>
              }
            >
              <div class={colsClass()}>
                <div class="info-source-images" style={{ "flex-basis": `${split() * 100}%` }}>
                  <For each={images()}>
                    {(image) => (
                      <div class="infoimg" data-file={image.file}>
                        <Zoomable
                          src={image.src}
                          alt={image.file}
                          zoomKey={`input:${im.host}:${image.file}`}
                          onOpen={() => store.actions.diff.openInput(im.host, image.file, image.fromOutput)}
                        />
                      </div>
                    )}
                  </For>
                </div>
                <div class="separator" onPointerDown={onSplitDown} />
                <div class="info-source-nodes" onClick={onTxtClick}>
                  <Head im={im} />
                  <MetaBody meta={im.meta ?? null} host={im.host} compareMeta={compareMeta()} skipImages />
                </div>
              </div>
            </Show>
          </Show>
        )}
      </Show>
    </div>
  );
}

// name/host header + dimensions/size sub-line + variation lineage row.
// Lives in the text half of the split.
function Head(props) {
  const store = useAppStore();
  const name = () => props.im.filename ?? props.im.name ?? "";
  const subText = () => {
    const im = props.im;
    const bits = [];
    if (im.meta?.width && im.meta?.height) bits.push(`${im.meta.width}×${im.meta.height}px`);
    const sz = im.size != null ? fmtBytes(im.size) : null;
    if (sz) bits.push(sz);
    return bits.length ? bits.join(" · ") : (im.host ? "" : "local anchor");
  };

  // variation lineage (the kz chunk): which image this one came from.
  // Click jumps to the source when it's in the loaded feed.
  const lineageSrc = () => {
    const source = props.im.meta?.lineage?.source;
    if (!source) return null;
    const [srcHost, srcFile] = source.split(/:(.*)/).slice(0, 2);
    return { srcHost, srcFile };
  };
  const srcIdx = () => {
    const s = lineageSrc();
    if (!s) return -1;
    return store.state.images.findIndex((i) => i.host === s.srcHost && i.filename === s.srcFile);
  };

  return (
    <div class="ws-head">
      <div class="ws-name" title={name()}>{name()}</div>
      <div class="ws-sub">{subText()}</div>
      <Show when={lineageSrc()}>
        {(s) => (
          <div class="ws-lineage">
            <Show
              when={srcIdx() >= 0}
              fallback={<span class="ws-lineage-src">{`variation of ${s().srcFile}`}</span>}
            >
              <a
                class="ws-lineage-src"
                href=""
                onClick={(e) => {
                  e.preventDefault();
                  store.actions.current.set(s().srcHost, s().srcFile);
                  store.actions.feed.restoreToIndex(srcIdx());
                }}
              >{`variation of ${s().srcFile}`}</a>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
