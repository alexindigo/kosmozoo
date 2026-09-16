// client-solid/components/DetailsBody.tsx — the current image's metadata
// details, declarative.
//
// Reads the store's current pointer (hidden images included). Field values
// that differ from the previous current image (stack top) render .pdiff.
// Discovered node images get their own column beside the text fields — the
// layout follows store.state.infoLayout. Filename links in the text column
// re-focus the images column on that image.

import { createSignal, createEffect, createMemo, For, Show } from "solid-js";
import { useAppStore, clampSplit } from "../store/app-store.js";
import { fmtBytes } from "../store/fields.js";
import { useDrag } from "../lib/drag.js";
import { flash } from "../lib/flash.js";
import { MetaBody } from "./MetaBody.js";
import { Zoomable } from "./Zoomable.js";

export function DetailsBody() {
  const store = useAppStore();
  // the store owns the pointer→entry derivation (G7): currentEntry for the
  // live pointer, entryFor for the history one
  const im = () => store.state.currentEntry()?.entry ?? null;
  const compareMeta = createMemo(() => store.state.entryFor(store.state.currentStack().at(-1) ?? null)?.entry?.meta ?? null);
  const images = () => store.state.currentNodeImages();
  const hasImages = () => images().length > 0;
  const colsClass = () => {
    const l = store.state.infoLayout();
    return "info " + (l === "rev" ? "rev" : l === "stacked" ? "stacked" : "split");
  };

  createEffect(() => {
    const resolved = im();
    if (resolved?.host && resolved.size == null) store.actions.images.fillSize(resolved.id);
  });

  // filename links in the text column focus the images column on that image —
  // MetaBody reports the click via onImageRef; the images column is ours.
  // The flash is a signal through the shared helper (G9)
  let infoEl;
  const [flashFile, setFlashFile] = createSignal(null);
  const [flashOn, setFlashOn] = createSignal(false);
  const fireFlash = flash(setFlashOn);
  const focusImage = (file) => {
    infoEl?.querySelector(`.infoimg[data-file="${CSS.escape(file)}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setFlashFile(file);
    fireFlash();
  };

  const split = () => store.ui.info.split;
  // the divider drag is the shared primitive (G8); the axis comes from the
  // layout model, not the DOM class
  const { dragging, ref: sepRef } = useDrag({
    axis: () => (store.state.infoLayout() === "stacked" ? "y" : "x"),
    onDrag: (ev, ctx) => store.actions.ui.info.split.set(clampSplit(ctx.frac)),
  });
  createEffect(() => store.actions.ui.setResizing(dragging()));

  return (
    <div class="info-body metabody">
      <Show when={im()} fallback={<div class="info-none">No image selected.</div>}>
        <Show
          when={im()?.meta || im()?.extracted !== false}
          fallback={<div class="info-none">loading metadata…</div>}
        >
          <Show
            when={hasImages()}
            fallback={
              <>
                <Head im={im()} />
                <MetaBody meta={im()?.meta ?? null} host={im()?.host} compareMeta={compareMeta()} />
              </>
            }
          >
            <div class={colsClass()} ref={(el) => { infoEl = el; }}>
              <div class="info-source-images" style={{ "flex-basis": `${split() * 100}%` }}>
                <For each={images()}>
                  {(image) => (
                    <div class="infoimg" data-file={image.file}
      classList={{ flash: flashOn() && flashFile() === image.file }}>
                      <Zoomable
                        src={image.src}
                        alt={image.file}
                        zoomKey={`input:${im()?.host}:${image.file}`}
                        onOpen={() => store.actions.diff.openInput(im()?.host, image.file, image.fromOutput)}
                      />
                    </div>
                  )}
                </For>
              </div>
              <div class="separator" ref={sepRef} />
              <div class="info-source-nodes">
                <Head im={im()} />
                <MetaBody meta={im()?.meta ?? null} host={im()?.host} compareMeta={compareMeta()} skipImages onImageRef={focusImage} />
              </div>
            </div>
          </Show>
        </Show>
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
    // the store's (host, filename) map owns the lookup — never a scan
    return store.state.entryFor({ remote: s.srcHost, image: s.srcFile })?.index ?? -1;
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
