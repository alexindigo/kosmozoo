// client-solid/components/SliderRow.tsx — one variations parameter row.
//
//  [☐]  label                                                    increment
//       min                                          max         [-][0.05][+]
//       ●──────────────●
//                current
//
// The dual-thumb slider is noUiSlider (vendored), bound in onMount on the
// lane's .vz-slider element: the library renders the track, thumbs and
// connect band there. Drag snaps to the row's increment (slide event);
// keyboard nudge on a focused thumb uses the fine step (options.step).
// Alignment is structural: rail, connect band, thumbs and the orange
// current-value marker share one lane centerline by construction.
//
// Two modes:
//   absolute — thumbs are min/max values; the marker sits at the image's
//              current value and its label shows it.
//   relative — batch sweeps: thumbs are signed OFFSETS from the current
//              value; the marker is pinned to the center and labeled "X".
//
// Props convention: enabled/increment/current are GETTERS (the parent's rows
// state outlives this row — <For> keeps it mounted across toggles); the rest
// (param, defaults, placeholderKey, relative, callbacks) are stable per row.
// The row never reaches into its parent — label clicks report through
// onInsertPlaceholder and the parent owns the form.

import { onMount, onCleanup } from "solid-js";
import { snapTo, fmt } from "/js/variations.mjs";

const fmtSigned = (v) => (v > 0 ? "+" : "") + fmt(v);

export function SliderRow(props) {
  let sliderEl, minLblEl, maxLblEl;
  const fineStep = Math.pow(10, -props.param.decimals);

  // absolute: the param's clamp; relative: ±(spread×10) around the current
  const lo = props.relative ? -(props.param.spread ?? 1) * 10 : props.param.clamp[0];
  const hi = props.relative ? (props.param.spread ?? 1) * 10 : props.param.clamp[1];
  const span = hi - lo;

  onMount(() => {
    // step: fineStep — keyboard nudges use the fine step directly. Drag
    // snapping is handled in the `slide` event, which only fires on drag.
    // The handlers read props live (Solid's props proxy), so the current
    // increment is always the one that snaps.
    const slider = noUiSlider.create(sliderEl, {
      start: [props.defaults.min, props.defaults.max],
      connect: true,
      range: { min: lo, max: hi },
      step: fineStep,
      behaviour: "drag",
      keyboardSupport: true,
    });
    slider.on("update", (values) => {
      const [a, b] = values.map(Number);
      minLblEl.textContent = props.relative ? fmtSigned(a) : fmt(a);
      maxLblEl.textContent = props.relative ? fmtSigned(b) : fmt(b);
      minLblEl.style.left = ((a - lo) / span) * 100 + "%";
      maxLblEl.style.left = ((b - lo) / span) * 100 + "%";
      const vals = slider.get().map(Number);
      props.onRange(props.param.key, { min: Math.min(vals[0], vals[1]), max: Math.max(vals[0], vals[1]) });
    });
    slider.on("slide", (values) => {
      const snapped = values.map((v) => snapTo(Number(v), props.increment(), props.param.decimals));
      if (snapped[0] !== Number(values[0]) || snapped[1] !== Number(values[1])) {
        slider.set(snapped.map(String));
      }
    });
    onCleanup(() => slider.destroy());
  });

  const commitInc = (v) => {
    props.onIncrement(props.param.key, Math.max(fineStep, +Number(v).toFixed(props.param.decimals + 3)));
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
            <div class="vz-bound vz-min-lbl" ref={minLblEl} />
            <div class="vz-bound vz-max-lbl" ref={maxLblEl} />
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
            <div class="vz-slider" ref={sliderEl} disabled={!props.enabled() || undefined} />
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
          type="number" class="vz-row-inc-input"
          value={String(props.increment())} step={String(fineStep)} min={String(fineStep)}
          disabled={!props.enabled() || undefined}
          onChange={(e) => commitInc(parseFloat(e.target.value) || props.param.defaultInc)}
        />
        <button
          class="vz-step-btn" title="larger step" disabled={!props.enabled() || undefined}
          onClick={() => commitInc(props.increment() * 2)}
        >+</button>
      </div>
    </div>
  );
}
