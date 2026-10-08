// client-solid/components/DiffChrome.tsx — the workbench chrome: close (X),
// keys button, the 1–4 mode control (state display + clickable; greyed and
// inert without a pair), and per-view extras (One-Up: side indicator +
// play/pause + interval). The stage never reaches into this component, and
// this component never reaches into the stage — everything flows through
// the store's diff tree.

// one icon button + its vertical slider popup (Kaleidoscope idiom): click
// the icon to open the popup above it (a tail points back); drag the track
// to set the value (bottom = min, top = max). The parent owns which popup
// is open (one at a time); the component never reaches out.

import { Show, For, createSignal, createEffect, onCleanup } from "solid-js";
import { useAppStore } from "../store/app-store.js";
import { iconSvg } from "/js/icons.mjs";

const MODES = [
  ["1", "two-up", "Two-Up", "view-two-up"],
  ["2", "one-up", "One-Up", "view-one-up"],
  ["3", "split", "Split", "view-split"],
  ["4", "difference", "Difference", "view-difference"],
];

function VSlider(props) {
  let trackEl;
  const setFromEvent = (ev) => {
    const r = trackEl.getBoundingClientRect();
    props.onInput(Math.min(1, Math.max(0, 1 - (ev.clientY - r.top) / r.height)));
  };
  const onDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const move = (ev) => setFromEvent(ev);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    setFromEvent(e);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  const pct = () => Math.round(props.value() * 1000) / 10;
  return (
    <span class="dz-vslider" title={props.title}>
      <button
        class={"dz-vbtn " + props.class + (props.open() ? " on" : "")}
        disabled={props.disabled || undefined}
        onClick={props.onToggle}
        innerHTML={iconSvg(props.icon, 14)}
      />
      <Show when={props.open()}>
        <span class="dz-vpop">
          <span class="dz-vtrack" ref={trackEl} onPointerDown={onDown}>
            <span class="dz-vfill" style={{ height: pct() + "%" }} />
            <span class="dz-vthumb" style={{ bottom: pct() + "%" }} />
          </span>
        </span>
      </Show>
    </span>
  );
}

export function DiffChrome() {
  const store = useAppStore();
  const d = () => store.state.diff;
  const hasB = () => !!store.state.diffPair().b;

  // one popup open at a time; Esc closes it (never the workbench), and a
  // pointerdown outside any control closes it too
  const [openCtl, setOpenCtl] = createSignal(null);
  onCleanup(store.handles.own("workbench.popup.close", () => setOpenCtl(null)));
  onCleanup(store.handles.own("workbench.popup.toggle", ({ control }) => setOpenCtl((cur) => cur === control ? null : control)));
  createEffect(() => {
    if (!openCtl()) return;
    const disposeLayer = store.actions.keys.pushLayer({ id: "workbench-popup", phase: "capture", command: "workbench.popup.close" });
    const onDown = (e) => {
      if (!e.target.closest?.(".dz-vslider")) store.handles.invoke("workbench.popup.close");
    };
    document.addEventListener("pointerdown", onDown, true);
    onCleanup(() => {
      disposeLayer();
      document.removeEventListener("pointerdown", onDown, true);
    });
  });
  const toggle = (control) => store.handles.invoke("workbench.popup.toggle", { control });

  return (
    <>
      <button
        id="diffClose" title="close (Esc)"
        onClick={() => store.handles.invoke("workbench.close")}
        innerHTML={iconSvg("x", 16)}
      />
      {/* ONE bottom panel holding all the buttons: controls at the left,
 the 1–4 modes centered, the keys button at the right */}
      <div id="diffBar">
        <div id="diffCtl">
          <button
            class="dz-sidebtn" title="active side — primary in every view (ArrowLeft/Right)"
            disabled={!hasB() || undefined}
            onClick={() => store.handles.invoke("workbench.column", { toggle: true })}
          >{d().col === "feed" ? "A" : "B"}</button>
          <button
            class={"dz-lockbtn" + (d().locked ? " on" : "")}
            title={d().locked ? "locked — gestures move both (l)" : "unlocked — gestures move the target (l)"}
            aria-pressed={d().locked}
            disabled={!hasB() || undefined}
            onClick={() => store.handles.invoke("workbench.lock", { toggle: true })}
            innerHTML={iconSvg(d().locked ? "lock" : "lock-open", 14)}
          />
          <VSlider
            icon="opacity" title="active image opacity" class="dz-active-op"
            value={() => d().activeOpacity}
            disabled={!hasB()}
            open={() => openCtl() === "active"}
            onToggle={() => toggle("active")}
            onInput={(value) => store.handles.invoke("workbench.parameters", { parameter: "activeOpacity", value })}
          />
          <Show when={hasB() && d().mode === "difference"}>
            <button
              class="dz-sidebtn" title="absolute / proportional highlight"
              onClick={() => store.handles.invoke("workbench.parameters", { parameter: "absolute", toggle: true })}
            >{d().diffAbs ? "abs" : "prop"}</button>
            <VSlider
              icon="filter" title="difference threshold — pixels within this delta count as matching" class="dz-threshold"
              value={() => d().diffThreshold / 64}
              open={() => openCtl() === "threshold"}
              onToggle={() => toggle("threshold")}
              onInput={(v) => store.handles.invoke("workbench.parameters", { parameter: "threshold", value: Math.round(v * 64) })}
            />
            <VSlider
              icon="contrast" title="highlight opacity" class="dz-mask-op"
              value={() => d().diffOpacity}
              open={() => openCtl() === "mask"}
              onToggle={() => toggle("mask")}
              onInput={(value) => store.handles.invoke("workbench.parameters", { parameter: "opacity", value })}
            />
          </Show>
        </div>
        <div id="diffModes" class="dz-seg">
          <For each={MODES}>
            {([key, m, label, icon]) => (
              <button
                class={"dz-segbtn" + (d().mode === m ? " on" : "")}
                disabled={!hasB() || undefined}
                title={`${label} (${key})`}
                onClick={() => store.handles.invoke("workbench.mode", { mode: m })}
                innerHTML={iconSvg(icon, 16)}
              />
            )}
          </For>
        </div>
        <button
          id="diffKeysBtn" title="actions & keys (?)"
          onClick={() => store.handles.invoke("keys.panel.toggle")}
          innerHTML={iconSvg("keyboard", 18)}
        />
      </div>
    </>
  );
}
