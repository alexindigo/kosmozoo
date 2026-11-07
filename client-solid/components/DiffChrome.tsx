// client-solid/components/DiffChrome.tsx — the workbench chrome: close (X),
// keys button, the available mode choices, and per-view extras (One-Up: side indicator +
// play/pause + interval). The stage never reaches into this component, and
// this component never reaches into the stage — everything flows through
// the store's diff tree.

// one icon button + its vertical slider popup (Kaleidoscope idiom): click
// the icon to open the popup above it (a tail points back); drag the track
// to set the value (bottom = min, top = max). The parent owns which popup
// is open (one at a time); the component never reaches out.

import { For, Show, createMemo, createSignal, createEffect, onCleanup } from "solid-js";
import { useAppStore } from "../store/app-store.js";
import { iconSvg } from "/js/icons.mjs";
import { IconButton } from "./IconButton.js";
import { ModeSwitch } from "./ModeSwitch.js";
import { viewerSide } from "../features/diff/views.mjs";
import { keyHint } from "../lib/key-hint.js";
import { FeatureContributions } from "../features/index.js";
import { Select } from "./Select.js";

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
    <span class="dz-vslider viewer-group">
      <IconButton viewer
        variant={"dz-vbtn " + props.class}
        title={props.title}
        active={props.open()}
        onAction={props.onToggle}
        icon={iconSvg(props.icon, 14)}
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

export function DiffChrome(props) {
  const store = useAppStore();
  const d = () => store.state.diff;
  const presentation = () => store.state.diffPresentation();
  const hasB = () => presentation().comparison;
  const alignments = createMemo(() => store.state.comparisonAlignments(), undefined,
    { equals: (a, b) => a?.length === b.length && a.every((option, i) => option.value === b[i].value && option.label === b[i].label) });
  const modes = () => store.state.diffViews().filter(({ mode }) => mode === "full" ||
    (!!store.state.diffPair().b && (mode !== "difference" || !props.differenceReason)));

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
      <span class="viewer-group viewer-close"><IconButton viewer
        id="diffClose" title={keyHint(store.state.bindings(), "close", "workbench.close")}
        onAction={() => store.handles.invoke("workbench.close")}
        icon={iconSvg("x", 16)}
      /></span>
      {/* ONE bottom panel holding all the buttons: controls at the left,
 the 1–4 modes centered, the keys button at the right */}
      <FeatureContributions store={store} slot="workbenchControls" />
      <div id="diffBar">
        <div id="diffCtl">
          <span class="viewer-control-slot viewer-side-slot"><Show when={hasB()}><span class="viewer-group"><button
            class="viewer-btn dz-sidebtn" title={keyHint(store.state.bindings(), "active side — primary in every view", "workbench.column")}
            onClick={() => store.handles.invoke("workbench.column", { toggle: true })}
          >{viewerSide[d().subject].label}</button></span></Show></span>
          <span class="viewer-control-slot viewer-alignment-slot"><Show when={hasB()}>
            <Select id="diffAlignment" size="viewer" aria-label="Comparison alignment"
              value={alignments().some(option => option.value === d().alignment) ? d().alignment : "independent"}
              title={keyHint(store.state.bindings(), "comparison alignment", "workbench.alignment.cycle") + "; " + keyHint(store.state.bindings(), "shared / independent", "workbench.lock")}
              onChange={e => store.handles.invoke("workbench.alignment", { mode: e.currentTarget.value })}>
              <For each={alignments()}>{option => <option value={option.value}>{option.label}</option>}</For>
            </Select>
          </Show></span>
          <span class="viewer-control-slot"><Show when={presentation().activeOpacity.available}>
          <VSlider
            icon="opacity" title={`active ${props.mediaWord ?? "image"} opacity`} class="dz-active-op"
            value={() => d().activeOpacity}
            open={() => openCtl() === "active"}
            onToggle={() => toggle("active")}
            onInput={(value) => store.handles.invoke("workbench.parameters", { parameter: "activeOpacity", value })}
          />
          </Show></span>
          <span class="viewer-control-slot viewer-side-slot"><Show when={hasB() && d().mode === "difference"}>
            <span class="viewer-group"><button
              class="viewer-btn dz-sidebtn" title="absolute / proportional highlight"
              onClick={() => store.handles.invoke("workbench.parameters", { parameter: "absolute", toggle: true })}
            >{d().diffAbs ? "abs" : "prop"}</button></span>
          </Show></span>
          <span class="viewer-control-slot"><Show when={hasB() && d().mode === "difference"}>
            <VSlider
              icon="filter" title="difference threshold — pixels within this delta count as matching" class="dz-threshold"
              value={() => d().diffThreshold / 64}
              open={() => openCtl() === "threshold"}
              onToggle={() => toggle("threshold")}
              onInput={(v) => store.handles.invoke("workbench.parameters", { parameter: "threshold", value: Math.round(v * 64) })}
            />
          </Show></span>
          <span class="viewer-control-slot"><Show when={presentation().highlightOpacity.available}>
            <VSlider
              icon="contrast" title="highlight opacity" class="dz-mask-op"
              value={() => d().diffOpacity}
              open={() => openCtl() === "mask"}
              onToggle={() => toggle("mask")}
              onInput={(value) => store.handles.invoke("workbench.parameters", { parameter: "opacity", value })}
            />
          </Show></span>
        </div>
        <div class="viewer-modes-slot"><Show when={modes().length > 1}><ModeSwitch id="diffModes" label="Comparison view" value={d().mode}
          options={modes().map(({ mode, label, icon }) => ({
            value: mode, label, view: label.toLowerCase(), variant: "dz-segbtn", icon: iconSvg(icon),
            title: keyHint(store.state.bindings(), label, "workbench.mode", { mode }),
          }))} onChange={mode => store.handles.invoke("workbench.mode", { mode })} /></Show></div>
        <span class="viewer-group viewer-keys"><IconButton viewer
          id="diffKeysBtn" title={keyHint(store.state.bindings(), "actions & keys", "keys.panel.toggle")}
          onAction={() => store.handles.invoke("keys.panel.toggle")}
          icon={iconSvg("keyboard", 18)}
        /></span>
      </div>
    </>
  );
}
