// Recipe-owned numeric mode and values; only the native widget/gesture lifetime
// belongs to the expanded body. Batch ranges use offsets; a Value is always fixed.

import { For, Show, createEffect, onMount, onCleanup } from "solid-js";
import noUiSlider from "/vendor/nouislider.mjs";
import { snapTo, fmt } from "./graph.mjs";
import { makeSliderGesture } from "./slider-gesture.js";
import { focusMemory } from "./draft.js";
import { ParameterRow, parameterName } from "./ParameterRow.js";
import { SingleLineText } from "../../components/SingleLineText.js";
import { IconButton } from "../../components/IconButton.js";
import { ModeSwitch } from "../../components/ModeSwitch.js";
import { TextField } from "../../components/TextField.js";
import { iconSvg } from "/js/icons.mjs";

export function SliderRow(props) {
  return <ParameterRow class="vz-slider-row" row={props.row} enabled={props.enabled} filteredOut={props.filteredOut}
    attributes={{ "data-param-key": props.param.key }}
    current={props.relative ? "varies by image" : fmt(props.current())} summary={props.summary}
    registerFocus={props.registerFocus} onInsert={props.onInsert} onEnable={checked => props.onToggle(props.param.key, checked)}>
    <Show when={props.row().mode} keyed>{mode => <NumericEditor {...props} mode={mode} />}</Show>
  </ParameterRow>;
}

// Raw fields live for the explicit mode, independently of representability.
// Only the slider child is retired when exact text cannot be drawn safely.
function NumericEditor(props) {
  const rawIncrement = () => props.rawIncrement();
  const focus = focusMemory(props.rememberFocus);
  const fineStep = Math.pow(10, -props.param.decimals);
  const single = props.mode === "value";
  const fields = single ? [{ key: "value", label: "value", aria: "Value", handle: "value" }]
    : [{ key: "min", label: "from", aria: "From", handle: "lower bound" }, { key: "max", label: "to", aria: "To", handle: "upper bound" }];
  const commitInc = (v) => {
    const next = Math.max(fineStep, +Number(v).toFixed(props.param.decimals + 3));
    props.onIncrement(props.param.key, String(next));
  };
  return <div class="vz-numeric-editor">
    <Show when={props.row().sliderSafe}><NumericSlider {...props} fields={fields} /></Show>
    <div class="vz-numeric-controls">
      <ModeSwitch label={`${parameterName(props.row())} mode`} value={props.mode}
        options={[{ value: "range", label: "Range" }, { value: "value", label: "Value" }]}
        onChange={mode => props.onField(props.param.key, "mode", mode)} />
      <div class="vz-range-fields">
        <For each={fields}>{field => <label class="vz-range-field" classList={{ "vz-value-field": single }}>
          {field.label}<TextField type="text" inputMode="decimal" aria-label={`${props.param.label} ${field.aria}`}
            value={props.row()[field.key]} aria-invalid={props.row().numbers[field.key] === null} {...focus}
            onInput={event => props.onField(props.param.key, field.key, event.currentTarget.value)} />
        </label>}</For>
        <Show when={!single}>
          <div class="vz-range-field"><label for={`step-${props.placeholderKey}`}>step</label>
            <div class="vz-row-inc">
              <Show when={props.row().sliderSafe && props.increment() > fineStep}><IconButton chrome size="md" variant="plain vz-step-btn" title="Halve step" aria-label={`${props.param.label}: Halve step`}
                icon={iconSvg("minus")} onAction={() => commitInc(Math.max(fineStep, props.increment() / 2))} /></Show>
              <TextField id={`step-${props.placeholderKey}`} type="text" inputMode="decimal" role="spinbutton" aria-label={`${props.param.label} increment`}
                aria-valuemin={fineStep} aria-valuenow={props.increment() ?? undefined}
                aria-invalid={props.increment() === null}
                class="vz-row-inc-input" value={rawIncrement()} {...focus}
                onInput={event => props.onIncrement(props.param.key, event.currentTarget.value)}
                onKeyDown={event => {
                  if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
                  const value = props.increment();
                  if (value === null || !Number.isFinite(value) || !props.row().sliderSafe) return;
                  event.preventDefault(); commitInc(value + (event.key === "ArrowUp" ? fineStep : -fineStep));
                }} />
              <Show when={props.row().sliderSafe && props.increment() !== null}><IconButton chrome size="md" variant="plain vz-step-btn" title="Double step" aria-label={`${props.param.label}: Double step`}
                icon={iconSvg("plus")} onAction={() => commitInc(props.increment() * 2)} /></Show>
            </div>
          </div>
        </Show>
      </div>
    </div>
  </div>;
}

// The widget owns initialization, projection, gestures and public suspension;
// its cleanup cannot replace or focus the sibling native raw fields.
function NumericSlider(props) {
  let sliderEl;
  let gesture;
  const focus = focusMemory(props.rememberFocus);
  let wasDragging = false;
  createEffect(() => { const enabled = !!props.enabled(); gesture?.setEnabled(enabled); });
  const fineStep = Math.pow(10, -props.param.decimals);
  const single = props.mode === "value";
  const relative = props.relative && !single;
  // The stable editor's descriptor also defines widget handle ordering.
  const fields = props.fields;

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
      start: fields.map((field, index) => props.row().numbers[field.key] ?? (single ? props.current() ?? lo : index ? hi : lo)),
      connect: !single,
      range: { min: lo, max: hi },
      step: fineStep,
      behaviour: "drag",
      // Programmatic field edits and release snapping are immediate numeric
      // writes. noUiSlider's animated set creates a tap state that rejects the
      // next real gesture, even after our physical-gesture lease has ended.
      animate: false,
      keyboardSupport: true,
      handleAttributes: fields.map(field => ({ "aria-label": `${parameterName(props.row())} ${field.handle}` })),
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
    createEffect(() => slider.set(fields.map(field => props.row().numbers[field.key])));
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

  // absolute: marker at the current value; relative: pinned to the center
  const markerPct = () => !props.row().sliderSafe ? null : relative
    ? 50
    : (props.current() != null
      ? ((props.current() - props.param.clamp[0]) / (props.param.clamp[1] - props.param.clamp[0])) * 100
      : null);

  return (
        <div class="vz-rangewrap">
          <div class="vz-lane vz-lane-track">
            <div class="vz-rail" />
            <div class="vz-marker-inset">
              <div class="vz-current-point" classList={{ "vz-current-unavailable": markerPct() == null }}
                style={{ left: markerPct() != null ? markerPct() + "%" : undefined }}>
                <div class="vz-marker" />
                <SingleLineText class="vz-editor-current" value={relative ? "varies by image" : fmt(props.current())} />
              </div>
            </div>
            <div class="vz-slider" ref={sliderEl} />
          </div>
        </div>
  );
}
