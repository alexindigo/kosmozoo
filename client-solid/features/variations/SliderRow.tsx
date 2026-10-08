// client-solid/components/SliderRow.tsx — one variations parameter row.
//
// [☐] label increment
// min max [-][0.05][+]
// ●──────────────●
// current
//
// The dual-thumb slider is noUiSlider (vendored ESM — no window global,
// ), bound in onMount on the lane's .vz-slider element: the library
// renders the track, thumbs and connect band there. Drag snaps to the row's
// increment (slide event); keyboard nudge on a focused thumb uses the fine
// step (options.step).
// Alignment is structural: rail, connect band, thumbs and the orange
// current-value marker share one lane centerline by construction.
//
// Two modes:
// absolute — thumbs are min/max values; the marker sits at the image's
// current value and its label shows it.
// relative — batch sweeps: thumbs are signed OFFSETS from the current
// value; the marker is pinned to the center and labeled "X".
//
// Props convention: enabled/increment/current are GETTERS (the parent's rows
// state outlives this row — <For> keeps it mounted across toggles); the rest
// (param, defaults, placeholderKey, relative, callbacks) are stable per row.
// The row never reaches into its parent — label clicks report through
// onInsertPlaceholder and the parent owns the form.

import { createSignal, createEffect, onMount, onCleanup } from "solid-js";
import noUiSlider from "/vendor/nouislider.mjs";
import { snapTo, fmt } from "./graph.mjs";
import { makeSliderGesture } from "./slider-gesture.js";
import { focusMemory } from "./draft.js";

const fmtSigned = (v) => (v > 0 ? "+" : "") + fmt(v);

export function SliderRow(props) {
  let sliderEl;
  let gesture;
  const [rawIncrement, setRawIncrement] = createSignal(String(props.increment()));
  const focus = focusMemory(props.rememberFocus);
  let wasDragging = false;
  createEffect(() => { const enabled = !!props.enabled(); gesture?.setEnabled(enabled); });
  const fineStep = Math.pow(10, -props.param.decimals);

  // the bound labels are signals rendered by JSX ( — no imperative
  // textContent/style writes from the library callback)
  const [minLbl, setMinLbl] = createSignal({ text: "", left: "0%" });
  const [maxLbl, setMaxLbl] = createSignal({ text: "", left: "0%" });

  // absolute: the param's clamp; relative: ±(spread×10) around the current
  const lo = props.relative ? -(props.param.spread ?? 1) * 10 : props.param.clamp[0];
  const hi = props.relative ? (props.param.spread ?? 1) * 10 : props.param.clamp[1];
  const span = hi - lo;

  onMount(() => {
    // step: fineStep — keyboard nudges use the fine step directly. The
    // `slide` event fires for BOTH pointer drags and keyboard nudges, so
    // the snap is gated on a real drag being in flight: a keyboard nudge
    // snapped to the (coarser) increment would be undone unless it crossed
    // a full increment — the fine step is its whole point. The handlers
    // read props live (Solid's props proxy), so the current increment is
    // always the one that snaps.
    const slider = noUiSlider.create(sliderEl, {
      start: [props.defaults.min, props.defaults.max],
      connect: true,
      range: { min: lo, max: hi },
      step: fineStep,
      behaviour: "drag",
      keyboardSupport: true,
    });
    gesture = makeSliderGesture(sliderEl, { gate: (enabled) => enabled ? slider.enable() : slider.disable(),
      onRetire: () => { wasDragging = false; } });
    slider.on("start", () => gesture.started());
    gesture.setEnabled(!!props.enabled());
    const disposeEditor = props.registerEditor?.({ suspend: gesture.suspend, resume: gesture.resume });
    const rememberWidget = (event) => focus.onFocus({ currentTarget: event.target });
    sliderEl.addEventListener("focusin", rememberWidget);
    // `update` tracks the bound LABELS live (it also fires on programmatic
    // set — the row's state is only ever written by user gestures)
    slider.on("update", (values) => {
      const [a, b] = values.map(Number);
      setMinLbl({ text: props.relative ? fmtSigned(a) : fmt(a), left: ((a - lo) / span) * 100 + "%" });
      setMaxLbl({ text: props.relative ? fmtSigned(b) : fmt(b), left: ((b - lo) / span) * 100 + "%" });
    });
    // onRange fires ONLY from slide/change (user gestures) — never from
    // `update`, which would re-report every programmatic set 
    const report = () => {
      if (gesture.suppressed()) return;
      const vals = slider.get().map(Number);
      props.onRange(props.param.key, { min: Math.min(vals[0], vals[1]), max: Math.max(vals[0], vals[1]) });
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
          const sn = snapTo(next[i], props.increment(), props.param.decimals);
          if (sn !== next[i]) { next[i] = sn; changed = true; }
        };
        if (handleNumber === undefined || handleNumber === null) { snapOne(0); snapOne(1); }
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
    setRawIncrement(raw);
    props.onIncrement(props.param.key, next, raw);
  };

  // absolute: marker at the current value; relative: pinned to the center
  const markerPct = () => props.relative
    ? 50
    : (props.current() != null
      ? ((props.current() - props.param.clamp[0]) / (props.param.clamp[1] - props.param.clamp[0])) * 100
      : null);

  return (
    <div
      class={"vz-slider-row" + (props.enabled() ? "" : " vz-off")}
      data-param-key={props.param.key}
    >
      <input
        type="checkbox" class="vz-cb"
        checked={props.enabled()}
        onChange={(e) => props.onToggle(props.param.key, e.target.checked)}
      />
      <div class="vz-slider-inner">
        <div
          class="vz-label"
          title={"click to insert {" + props.placeholderKey + "} into prefix/suffix"}
          onMouseDown={(e) => {
            // the label never touches the parent's inputs — it emits and
            // the parent inserts (it owns prefix/suffix state)
            if (!props.onInsertPlaceholder) return;
            e.preventDefault(); // keep the input's focus/selection
            props.onInsertPlaceholder(props.placeholderKey);
          }}
        >{props.param.label}</div>
        <div class="vz-rangewrap">
          <div class="vz-lane vz-lane-labels">
            <div class="vz-bound vz-min-lbl" style={{ left: minLbl().left }}>{minLbl().text}</div>
            <div class="vz-bound vz-max-lbl" style={{ left: maxLbl().left }}>{maxLbl().text}</div>
          </div>
          <div class="vz-lane vz-lane-track">
            {/* the full-range track line spans the inset span, so its ends are
 exactly where the thumbs land at min/max */}
            <div class="vz-rail" />
            {/* the marker's reference box shares the slider's inset span, so
 the marker stays centered on the value point */}
            <div class="vz-marker-inset">
              <div
                class="vz-marker"
                style={markerPct() != null ? { left: markerPct() + "%" } : { display: "none" }}
              />
            </div>
            {/* the slider insets itself within the lane; the library's base
 fills it, so thumb centers travel exactly the inset span */}
            <div class="vz-slider" ref={sliderEl} />
          </div>
          <div class="vz-lane vz-lane-current">
            <div
              class="vz-current"
              style={markerPct() != null ? { left: markerPct() + "%" } : { display: "none" }}
            >{markerPct() != null ? (props.relative ? "X" : fmt(props.current())) : ""}</div>
          </div>
        </div>
      </div>
      <div class="vz-row-inc">
        <button
          class="vz-step-btn" title="smaller step" disabled={!props.enabled() || undefined}
          onClick={() => commitInc(Math.max(fineStep, props.increment() / 2))}
        >−</button>
        <input
          type="text" inputMode="decimal" role="spinbutton" aria-label={`${props.param.label} increment`}
          aria-valuemin={fineStep} aria-valuenow={Number.isFinite(Number(rawIncrement())) && rawIncrement().trim() ? Number(rawIncrement()) : undefined}
          class="vz-row-inc-input" value={rawIncrement()} {...focus}
          disabled={!props.enabled() || undefined}
          onInput={(e) => {
            const raw = e.currentTarget.value;
            setRawIncrement(raw);
            const value = raw.trim() ? Number(raw) : NaN;
            props.onIncrement(props.param.key, Number.isFinite(value) && value >= fineStep ? value : null, raw);
          }}
          onKeyDown={(e) => {
            if (!["ArrowUp", "ArrowDown"].includes(e.key)) return;
            const value = Number(rawIncrement());
            if (!rawIncrement().trim() || !Number.isFinite(value)) return;
            e.preventDefault();
            commitInc(value + (e.key === "ArrowUp" ? fineStep : -fineStep));
          }}
        />
        <button
          class="vz-step-btn" title="larger step" disabled={!props.enabled() || undefined}
          onClick={() => commitInc(props.increment() * 2)}
        >+</button>
      </div>
    </div>
  );
}
