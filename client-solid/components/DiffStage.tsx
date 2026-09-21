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

import { createSignal, createResource, createEffect, on, onMount, onCleanup, Show } from "solid-js";
import { useAppStore } from "../store/app-store.js";
import { makeZoomable } from "/js/zoomable.mjs";
import { DiffChrome } from "./DiffChrome.js";

// one decode-guarded src per side: the visible src swaps only once the new
// image decodes; a failed decode RESOLVES to the last good src
function useSideSrc(store, sideFn) {
  let lastGood = null;
  const [src] = createResource(
    () => (store.state.diff.open && sideFn() ? store.actions.diff.resolve(sideFn())?.src ?? null : null),
    async (url) => {
      const img = new Image();
      img.src = url;
      try {
        await img.decode();
        lastGood = url;
        return url;
      } catch {
        return lastGood;
      }
    },
  );
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
  const hasB = () => !!pair().b;

  // the shared zoom's render state — the behavior emits it, JSX copies it
  // onto every visible layer
  const [transform, setTransform] = createSignal("");
  let stageEl;
  let binding = null;
  // persist under the feed side's key (the feed card / info panel share it);
  // a feed-less single image (anchor-only) keeps the anchor key
  const zoomKey = () => {
    const side = pair().a ?? pair().b;
    return side ? `${side.source}:${side.file}` : null;
  };
  createEffect(on(
    () => (store.state.diff.open ? zoomKey() : null),
    (key) => {
      binding?.dispose();
      binding = null;
      setTransform("");
      if (!stageEl || !key) return;
      binding = makeZoomable(stageEl, {
        key,
        getView: store.actions.views.get,
        setView: store.actions.views.set,
        onTransform: (t) => setTransform(t),
      });
    },
  ));
  onCleanup(() => { binding?.dispose(); binding = null; });

  // One-Up auto-play: flip the visible column on the interval, only while
  // both sides hold a decoded src (a blink never swaps into a blank)
  createEffect(() => {
    if (!(d().open && d().playing && d().mode === "one-up" && hasB())) return;
    const t = setInterval(() => {
      if (!srcA() || !srcB()) return;
      store.actions.diff.setCol(d().col === "feed" ? "right" : "feed");
    }, d().intervalMs);
    onCleanup(() => clearInterval(t));
  });

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
      store.actions.diff.setSplit((ev.clientX - r.left) / r.width);
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

  return (
    <div id="diff" hidden={!d().open}>
      <DiffChrome />
      <div
        id="diffStage" ref={stageEl}
        data-mode={d().mode} data-col={d().col}
        style={{ "--split": d().splitT }}
      >
        <div class="dz-cell dz-a">
          <img class="dz-img" src={srcA() ?? undefined} alt="" style={{ transform: transform() || undefined }} />
        </div>
        <Show when={hasB()}>
          <div class="dz-cell dz-b">
            <img class="dz-img" src={srcB() ?? undefined} alt="" style={{ transform: transform() || undefined }} />
          </div>
          <Show when={d().mode === "split"}>
            <Wipe onDown={onSplitDown} />
          </Show>
        </Show>
      </div>
    </div>
  );
}
