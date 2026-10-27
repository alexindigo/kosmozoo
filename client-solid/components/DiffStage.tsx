// client-solid/components/DiffStage.tsx — the workbench surface: the
// two-sided comparator (feed current × right-pane current).
//
// Both sides stay MOUNTED and decode-guarded (one resource per side; a
// failed decode resolves to the last good src, never blanks) — the views
// only change layout, visibility, or clip, so a blink never reloads.
// Shared zoom: ONE view state, bound to the stage box and copied onto every
// visible layer; the key is the feed side's "<source>:<file>" (the same key
// the feed card and info panel use — a crop carries across views). Views:
// two-up (key 1), one-up blink (2), split wipe (3), difference mask (4).
// No pair (no B) → single image, like a one-file Kaleidoscope.

import { createMemo, createSignal, createEffect, on, onMount, onCleanup, Show } from "solid-js";
import { useAppStore } from "../store/app-store.js";
import { makeZoomable } from "/js/zoomable.mjs";
import { differenceMask, viewRect } from "../features/diff/mask.mjs";
import { hitLayer } from "../features/diff/hit.mjs";
import { DiffChrome } from "./DiffChrome.js";
import { MediaBox } from "./MediaBox.js";
import { mediaKind } from "/shared/backings/mime.mjs";

// one decode-guarded src per side: the visible src swaps only once the new
// image decodes; a failed decode RESOLVES to the last good src
function useSideSrc(store, sideFn) {
  let lastGood = null;
  const [src, setSrc] = createSignal(null);
  const candidate = createMemo(() => {
    const side = sideFn(), resolved = store.state.diff.open && side ? store.actions.diff.resolve(side) : null;
    return resolved ? { src: resolved.src, name: resolved.name, kind: mediaKind(resolved.name) ?? "image" } : null;
  }, undefined, { equals: (a, b) => a?.src === b?.src && a?.name === b?.name });
  createEffect(() => {
    const next = candidate();
    if (!next) { setSrc(null); return; }
    let retired = false;
    const playable = next.kind !== "image", el = playable ? document.createElement(next.kind) : new Image();
    const settle = ok => {
      if (retired) return;
      if (ok) lastGood = next;
      setSrc(ok ? next : lastGood ?? { ...next, failed: true });
      release();
    };
    const release = () => {
      clearTimeout(deadline); el.onload = el.onerror = el.onloadeddata = null;
      if (playable) el.pause();
      el.removeAttribute("src");
      if (playable) el.load();
    };
    const deadline = setTimeout(() => settle(false), 30000);
    el.onerror = () => settle(false);
    if (playable) { el.preload = "auto"; el.onloadeddata = () => settle(true); }
    el.src = next.src;
    if (!playable) el.decode().then(() => settle(true), () => settle(false));
    onCleanup(() => { retired = true; release(); });
  });
  return src;
}

// the wipe handle: native pointerdown — Solid delegates pointer handlers to
// document, where stopPropagation would arrive after the stage's own
// (native) zoom listener already saw the event; the native binding on the
// handle itself fires first
function Wipe(props) {
  let el;
  onMount(() => {
    el.addEventListener("pointerdown", props.onDown);
    onCleanup(() => el?.removeEventListener("pointerdown", props.onDown));
  });
  return <div class="dz-wipe" title="drag the wipe" ref={el} />;
}

export function DiffStage() {
  const store = useAppStore();
  const pair = () => store.state.diffPair();
  const srcA = useSideSrc(store, () => pair().a);
  const srcB = useSideSrc(store, () => pair().b);
  const d = () => store.state.diff;
  const hasB = () => !!pair().b && mediaKind(pair().a?.file) !== "audio";
  const differenceReason = () => store.state.differenceReason() ||
    ([srcA(), srcB()].some(side => side && side.kind !== "image") ? "difference mode compares still images" : null);
  const mode = () => mediaKind(pair().a?.file) === "audio" || (d().mode === "difference" && differenceReason()) ? "two-up" : d().mode;

  // TWO view states, one per side. Each layer's transform derives from its
  // own key in the store's views (view-fraction space; the layer's own box
  // turns fractions into px). Locked = the gesture's delta also writes the
  // peer key (entangle, never copy); unlocked = only the target's key.
  const keyA = () => (pair().a ? `${pair().a.source}:${pair().a.file}` : null);
  const keyB = () => (pair().b ? `${pair().b.source}:${pair().b.file}` : null);
  const layerT = (el, key) => {
    const v = key ? store.state.views[key] : null;
    if (!el || !v || !(v.s > 1 || v.txf || v.tyf)) return "";
    return `translate(${v.txf * el.offsetWidth}px, ${v.tyf * el.offsetHeight}px) scale(${v.s})`;
  };
  let stageEl, cellAEl, cellBEl;
  const tA = createMemo(() => layerT(cellAEl, keyA()));
  const tB = createMemo(() => layerT(cellBEl, keyB()));

  // one binding on the stage box; the gesture's target is the layer VISIBLE
  // at the pointer (hitLayer — derived from the same layout state the
  // renderer uses, so no layer is ever unreachable). Locked adds the peer
  // key as the delta's second target. THE REFERENCE BOX: the layer's own
  // cell in every mode EXCEPT Difference — there the cells are display:none
  // (0×0 — dividing by them would poison the view with NaN), so the stage
  // itself is the box the mask draws against.
  const targetFor = (e) => {
    const layer = hitLayer({
      mode: mode(), col: d().col, splitT: d().splitT,
      x: e.clientX,
      cellBRect: hasB() ? cellBEl.getBoundingClientRect() : null,
      stageRect: stageEl.getBoundingClientRect(),
    });
    const box = mode() === "difference" ? stageEl : (layer === "b" ? cellBEl : cellAEl);
    return { key: layer === "b" ? keyB() : keyA(), box };
  };
  const alsoFor = (t) => {
    if (!d().locked || !hasB()) return null;
    return t.key === keyA() ? keyB() : keyA();
  };
  let binding = null;
  createEffect(on(
    () => store.state.diff.open,
    (open) => {
      binding?.dispose();
      binding = null;
      if (!stageEl || !open) return;
      binding = makeZoomable(stageEl, {
        target: targetFor,
        also: alsoFor,
        panAlways: true, // the comparator pans at any zoom; cards keep zoomed-only pan
        getView: store.actions.views.get,
        setView: store.actions.views.set,
      });
    },
  ));
  onCleanup(() => { binding?.dispose(); binding = null; });

  // the split wipe: --split is the single source of the wipe position; the
  // drag is measured in stage fraction. The handle's pointerdown is eaten so
  // a wipe drag never starts a pan — NATIVE binding (the Wipe component):
  // Solid delegates pointerdown to document, where stopPropagation would
  // arrive after the stage's own (native) zoom listener already saw the event
  const onSplitDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const move = (ev) => {
      const r = stageEl.getBoundingClientRect();
      store.handles.invoke("workbench.parameters", { parameter: "split", value: (ev.clientX - r.left) / r.width });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  // Difference: mode 4 diffs THE TWO CURRENT CROPS — each photo drawn into
  // a stage-sized buffer through its own view (viewRect), then masked. The
  // canvas is stage-sized and carries NO transform: the crops are already
  // in the pixels. Recomputes when either src, either view, col (the base),
  // diffAbs, or diffOpacity changes; keeps its last paint (never blanks).
  let canvasEl;
  createEffect(() => {
    const aUrl = srcA()?.src, bUrl = srcB()?.src;
    const absolute = d().diffAbs, opacity = d().diffOpacity, baseIsA = d().col === "feed";
    const baseOpacity = d().activeOpacity, threshold = d().diffThreshold;
    const vA = keyA() ? store.state.views[keyA()] : null;
    const vB = keyB() ? store.state.views[keyB()] : null;
    if (mode() !== "difference" || differenceReason() || !hasB() || !aUrl || !bUrl || !canvasEl) return;
    let cancelled = false;
    (async () => {
      const load = (u) => new Promise((res) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => res(null);
        im.src = u;
      });
      const [ia, ib] = await Promise.all([load(aUrl), load(bUrl)]);
      if (cancelled || !ia || !ib) return;
      const stage = stageEl.getBoundingClientRect();
      const W = Math.round(stage.width), H = Math.round(stage.height);
      const grab = (im, v) => {
        const c = document.createElement("canvas");
        c.width = W; c.height = H;
        const x = c.getContext("2d", { willReadFrequently: true });
        const r = viewRect(im.naturalWidth, im.naturalHeight, v, W, H);
        x.drawImage(im, r.dx, r.dy, r.dw, r.dh);
        return x.getImageData(0, 0, W, H);
      };
      const mask = differenceMask(grab(ia, vA), grab(ib, vB), { absolute, opacity, baseIsA, baseOpacity, threshold });
      if (cancelled) return;
      canvasEl.width = W; canvasEl.height = H;
      canvasEl.getContext("2d").putImageData(mask, 0, 0);
    })();
    onCleanup(() => { cancelled = true; });
  });

  return (
    <div id="diff" hidden={!d().open}>
      <DiffChrome singleView={mediaKind(pair().a?.file) === "audio"} differenceReason={differenceReason()} mediaWord={((d().col === "right" ? srcB() : srcA())?.kind ?? "image").replace("audio", "audio file")} />
      <div
        id="diffStage" ref={stageEl}
        data-mode={mode()} data-col={d().col}
        style={{ "--split": d().splitT, "--active-op": d().activeOpacity }}
      >
        <div class="dz-cell dz-a" ref={cellAEl}>
          <MediaBox workbench src={srcA()?.src} kind={srcA()?.kind} alt={srcA()?.name} failed={srcA()?.failed}
            transform={tA()} active={d().open && (mode() !== "one-up" || d().col === "feed" || !hasB())} primary={d().col === "feed" || !hasB()}
            registerPlayer={store.actions.media.register} onPlaybackError={store.actions.media.report}
            onOpen={() => store.handles.invoke("workbench.open")} />
        </div>
        <Show when={hasB()}>
          <div class="dz-cell dz-b" ref={cellBEl}>
            <MediaBox workbench src={srcB()?.src} kind={srcB()?.kind} alt={srcB()?.name} failed={srcB()?.failed}
              transform={tB()} active={d().open && (mode() !== "one-up" || d().col === "right")} primary={d().col === "right"}
              registerPlayer={store.actions.media.register} onPlaybackError={store.actions.media.report}
              onOpen={() => store.handles.invoke("workbench.open")} />
          </div>
          <Show when={mode() === "split"}>
            <Wipe onDown={onSplitDown} />
          </Show>
        </Show>
        <Show when={hasB() && mode() === "difference"}>
          <div class="dz-cell dz-canvas-cell">
            <canvas class="dz-canvas" ref={canvasEl} />
          </div>
        </Show>
      </div>
    </div>
  );
}
