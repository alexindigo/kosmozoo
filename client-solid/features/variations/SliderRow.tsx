// Recipe-owned numeric mode and values; only the native widget/gesture lifetime
// belongs to the expanded body. Batch ranges use offsets; a Value is always fixed.

import { Show, createEffect, onMount, onCleanup } from "solid-js";
import noUiSlider from "/vendor/nouislider.mjs";
import { snapTo, fmt } from "./graph.mjs";
import { makeSliderGesture } from "./slider-gesture.js";
import { focusMemory } from "./draft.js";
import { ParameterRow, parameterName } from "./ParameterRow.js";
import { SingleLineText } from "../../components/SingleLineText.js";
import { IconButton } from "../../components/IconButton.js";

export function SliderRow(props) {
  return <ParameterRow class="vz-slider-row" row={props.row} enabled={props.enabled}
    attributes={{ "data-param-key": props.param.key }}
    current={props.relative ? "varies by image" : fmt(props.current())} summary={props.summary}
    onInsert={props.onInsert} onEnable={checked => props.onToggle(props.param.key, checked)}>
    <Show when={props.row().mode} keyed>{mode => <NumericEditor {...props} mode={mode} />}</Show>
  </ParameterRow>;
}

// Only the native widget lifetime belongs to the expanded body. The recipe owns
// every editable value, so a fresh widget restores the latest retained bounds.
function NumericEditor(props) {
  let sliderEl;
  let gesture;
  const rawIncrement = () => props.rawIncrement();
  const focus = focusMemory(props.rememberFocus);
  let wasDragging = false;
  createEffect(() => { const enabled = !!props.enabled(); gesture?.setEnabled(enabled); });
  const fineStep = Math.pow(10, -props.param.decimals);
  const single = props.mode === "value";
  const relative = props.relative && !single;

  // absolute: the param's clamp; relative: ±(spread×10) around the current
  const lo = relative ? -(props.param.spread ?? 1) * 10 : props.param.clamp[0];
  const hi = relative ? (props.param.spread ?? 1) * 10 : props.param.clamp[1];

  onMount(() => {
    // step: fineStep — keyboard nudges use the fine step directly. The
    // `slide` event fires for BOTH pointer drags and keyboard nudges, so
    // the snap is gated on a real drag being in flight: a keyboard nudge
    // snapped to the (coarser) increment would be undone unless it crossed
    // a full increment — the fine step is its whole point. The handlers
    // read props live (Solid's props proxy), so the current increment is
    // always the one that snaps.
    const slider = noUiSlider.create(sliderEl, {
      // Invalid text has no numeric position. This fallback only places a newly
      // mounted widget; it never writes a value back into the raw recipe.
      start: single ? [props.row().numbers.value ?? props.current() ?? lo]
        : [props.row().numbers.min ?? lo, props.row().numbers.max ?? hi],
      connect: !single,
      range: { min: lo, max: hi },
      step: fineStep,
      behaviour: "drag",
      // Programmatic field edits and release snapping are immediate numeric
      // writes. noUiSlider's animated set creates a tap state that rejects the
      // next real gesture, even after our physical-gesture lease has ended.
      animate: false,
      keyboardSupport: true,
      handleAttributes: single ? [{ "aria-label": `${parameterName(props.row())} value` }] : [
        { "aria-label": `${parameterName(props.row())} lower bound` },
        { "aria-label": `${parameterName(props.row())} upper bound` },
      ],
    });
    gesture = makeSliderGesture(sliderEl, { gate: (enabled) => enabled ? slider.enable() : slider.disable(),
      onRetire: () => { wasDragging = false; } });
    slider.on("start", () => gesture.started());
    gesture.setEnabled(!!props.enabled());
    const disposeEditor = props.registerEditor?.({ suspend: gesture.suspend, resume: gesture.resume });
    const rememberWidget = (event) => focus.onFocus({ currentTarget: event.target });
    sliderEl.addEventListener("focusin", rememberWidget);
    // The widget projects parsed recipe values; null leaves that handle in
    // place. Programmatic projection never replaces the user's raw text.
    createEffect(() => slider.set(single ? [props.row().numbers.value]
      : [props.row().numbers.min, props.row().numbers.max]));
    // onRange fires ONLY from slide/change (user gestures) — never from
    // `update`, which would re-report every programmatic set 
    const report = () => {
      if (gesture.suppressed()) return;
      const vals = [slider.get()].flat().map(Number);
      if (single) props.onField(props.param.key, "value", fmt(vals[0]));
      else props.onRange(props.param.key, { min: fmt(Math.min(vals[0], vals[1])), max: fmt(Math.max(vals[0], vals[1])) });
    };
    // The snap lands on RELEASE, never mid-drag: a set during an active
    // drag puts the widget in its tap-transition state, which rejects the
    // drag's own move events — the thumb would freeze at the first snap.
    // While dragging, the thumb follows the pointer freely (the labels
    // track it live via `update`); the change event at the end snaps the
    // dragged handle — and only it — to the row's increment. Keyboard
    // nudges never set wasDragging, so their fine step survives.
    slider.on("slide", () => {
      if (gesture.suppressed()) return;
      if (gesture.dragging()) wasDragging = true;
      report();
    });
    slider.on("change", (values, handleNumber) => {
      if (gesture.suppressed()) return;
      if (wasDragging) {
        wasDragging = false;
        const next = values.map(Number);
        let changed = false;
        const snapOne = (i) => {
          const sn = snapTo(next[i], single ? fineStep : props.increment(), props.param.decimals);
          if (sn !== next[i]) { next[i] = sn; changed = true; }
        };
        if (handleNumber === undefined || handleNumber === null) next.forEach((_, i) => snapOne(i));
        else snapOne(handleNumber);
        if (changed) slider.set(next.map(String));
      }
      report();
    });
    onCleanup(() => {
      disposeEditor?.();
      sliderEl.removeEventListener("focusin", rememberWidget);
      gesture.dispose();
      slider.destroy();
    });
  });

  const commitInc = (v) => {
    const next = Math.max(fineStep, +Number(v).toFixed(props.param.decimals + 3));
    const raw = String(next);
    props.onIncrement(props.param.key, raw);
  };

  // absolute: marker at the current value; relative: pinned to the center
  const markerPct = () => relative
    ? 50
    : (props.current() != null
      ? ((props.current() - props.param.clamp[0]) / (props.param.clamp[1] - props.param.clamp[0])) * 100
      : null);

  return (
      <div class="vz-numeric-editor">
        <div class="vz-rangewrap">
          <div class="vz-lane vz-lane-track">
            <div class="vz-rail" />
            <div class="vz-marker-inset">
              <div class="vz-current-point" style={markerPct() != null ? { left: markerPct() + "%" } : { display: "none" }}>
                <div class="vz-marker" />
                <SingleLineText class="vz-editor-current" value={relative ? "varies by image" : fmt(props.current())} />
              </div>
            </div>
            <div class="vz-slider" ref={sliderEl} />
          </div>
        </div>
        <div class="vz-numeric-controls">
          <div class="viewer-group vz-numeric-mode" role="group" aria-label={`${parameterName(props.row())} mode`}>
            <IconButton viewer icon="Range" title="Range" active={!single} onAction={() => props.onField(props.param.key, "mode", "range")} />
            <IconButton viewer icon="Value" title="Value" active={single} onAction={() => props.onField(props.param.key, "mode", "value")} />
          </div>
          <Show when={single} fallback={<div class="vz-range-fields">
          <label class="vz-range-field">from<input type="text" inputMode="decimal" aria-label={`${props.param.label} From`}
            value={props.row().min} aria-invalid={props.row().numbers.min === null} {...focus}
            onInput={event => props.onField(props.param.key, "min", event.currentTarget.value)} /></label>
          <label class="vz-range-field">to<input type="text" inputMode="decimal" aria-label={`${props.param.label} To`}
            value={props.row().max} aria-invalid={props.row().numbers.max === null} {...focus}
            onInput={event => props.onField(props.param.key, "max", event.currentTarget.value)} /></label>
          <div class="vz-range-field"><label for={`step-${props.placeholderKey}`}>step</label>
            <div class="vz-row-inc">
              <button type="button" class="vz-step-btn" title="Halve step" aria-label={`${props.param.label}: Halve step`}
                onClick={() => commitInc(Math.max(fineStep, props.increment() / 2))}>−</button>
              <input id={`step-${props.placeholderKey}`} type="text" inputMode="decimal" role="spinbutton" aria-label={`${props.param.label} increment`}
                aria-valuemin={fineStep} aria-valuenow={props.increment() ?? undefined}
                aria-invalid={props.increment() === null}
                class="vz-row-inc-input" value={rawIncrement()} {...focus}
                onInput={event => props.onIncrement(props.param.key, event.currentTarget.value)}
                onKeyDown={event => {
                  if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
                  const value = props.increment();
                  if (value === null || !Number.isFinite(value)) return;
                  event.preventDefault(); commitInc(value + (event.key === "ArrowUp" ? fineStep : -fineStep));
                }} />
              <button type="button" class="vz-step-btn" title="Double step" aria-label={`${props.param.label}: Double step`}
                onClick={() => commitInc(props.increment() * 2)}>+</button>
            </div>
          </div>
          </div>}>
            <label class="vz-range-field vz-value-field">value<input type="text" inputMode="decimal" aria-label={`${props.param.label} Value`}
              value={props.row().value} aria-invalid={props.row().numbers.value === null} {...focus}
              onInput={event => props.onField(props.param.key, "value", event.currentTarget.value)} /></label>
          </Show>
        </div>
      </div>
  );
}
