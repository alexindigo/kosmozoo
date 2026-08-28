// client/app/components/SliderRow.mjs — one variations parameter row.
//
//  [☐]  label                                                    increment
//       min                                          max         [-][0.05][+]
//       ●──────────────●
//                current
//
// The dual-thumb slider is noUiSlider (vendored), bound inside useEffect on
// the lane's .vz-slider element: the library renders the track, thumbs and
// connect band there. Drag snaps to the row's increment (slide event);
// keyboard nudge on a focused thumb uses the fine step (options.step).
// Alignment is structural: rail, connect band, thumbs and the orange
// current-value marker share one lane centerline by construction.
//
// Two modes:
//   absolute — thumbs are min/max values; the marker sits at the image's
//              current value and its label shows it.
//   relative — batch sweeps: thumbs are signed OFFSETS from the current
//              value (both may sit on the same side of it); the marker is
//              pinned to the center and labeled "X" because every image in
//              the batch has its own current value.

import { h, useEffect, useRef } from "../../vendor/preact/vendor.mjs";
import { snapTo, fmt } from "../../js/variations.mjs";

const fmtSigned = (v) => (v > 0 ? "+" : "") + fmt(v);

export function SliderRow({
  param, current, defaults, enabled, increment, placeholderKey, relative,
  onToggle, onRange, onIncrement, templateTarget,
}) {
  const sliderRef = useRef(null);
  const minLblRef = useRef(null);
  const maxLblRef = useRef(null);
  const fineStep = Math.pow(10, -param.decimals);

  // absolute: the param's clamp; relative: ±(spread×10) around the current
  const lo = relative ? -(param.spread ?? 1) * 10 : param.clamp[0];
  const hi = relative ? (param.spread ?? 1) * 10 : param.clamp[1];
  const span = hi - lo;

  // the slide handler must snap to the CURRENT increment; the effect's
  // closure is mount-once, so it reads through a ref
  const incRef = useRef(increment);
  incRef.current = increment;

  useEffect(() => {
    // step: fineStep — keyboard nudges use the fine step directly. Drag
    // snapping is handled in the `slide` event, which only fires on drag.
    const slider = noUiSlider.create(sliderRef.current, {
      start: [defaults.min, defaults.max],
      connect: true,
      range: { min: lo, max: hi },
      step: fineStep,
      behaviour: "drag",
      keyboardSupport: true,
    });
    slider.on("update", (values) => {
      const [a, b] = values.map(Number);
      minLblRef.current.textContent = relative ? fmtSigned(a) : fmt(a);
      maxLblRef.current.textContent = relative ? fmtSigned(b) : fmt(b);
      minLblRef.current.style.left = ((a - lo) / span) * 100 + "%";
      maxLblRef.current.style.left = ((b - lo) / span) * 100 + "%";
      const vals = slider.get().map(Number);
      onRange(param.key, { min: Math.min(vals[0], vals[1]), max: Math.max(vals[0], vals[1]) });
    });
    slider.on("slide", (values) => {
      const snapped = values.map((v) => snapTo(Number(v), incRef.current, param.decimals));
      if (snapped[0] !== Number(values[0]) || snapped[1] !== Number(values[1])) {
        slider.set(snapped.map(String));
      }
    });
    return () => slider.destroy();
  }, []);

  const commitInc = (v) => {
    onIncrement(param.key, Math.max(fineStep, +Number(v).toFixed(param.decimals + 3)));
  };

  // absolute: marker at the current value; relative: pinned to the center
  const markerPct = relative
    ? 50
    : (current != null ? ((current - param.clamp[0]) / (param.clamp[1] - param.clamp[0])) * 100 : null);

  return h("div", {
    class: "vz-slider-row" + (enabled ? "" : " vz-off"),
    "data-param-key": param.key,
  },
    h("input", {
      type: "checkbox", class: "vz-cb", checked: enabled,
      onChange: (e) => onToggle(param.key, e.target.checked),
    }),
    h("div", { class: "vz-slider-inner" },
      h("div", {
        class: "vz-label",
        title: "click to insert {" + placeholderKey + "} into prefix/suffix",
        onMouseDown: (e) => {
          if (!templateTarget?.input) return;
          e.preventDefault();
          const inp = templateTarget.input;
          const s = templateTarget.start;
          const en = templateTarget.end;
          const placeholder = "{" + placeholderKey + "}";
          inp.value = inp.value.slice(0, s) + placeholder + inp.value.slice(en);
          const caret = s + placeholder.length;
          inp.setSelectionRange(caret, caret);
          templateTarget.start = caret;
          templateTarget.end = caret;
          inp.focus();
        },
      }, param.label),
      h("div", { class: "vz-rangewrap" },
        h("div", { class: "vz-lane vz-lane-labels" },
          h("div", { class: "vz-bound vz-min-lbl", ref: minLblRef }),
          h("div", { class: "vz-bound vz-max-lbl", ref: maxLblRef }),
        ),
        h("div", { class: "vz-lane vz-lane-track" },
          // the full-range track line spans the inset span, so its ends are
          // exactly where the thumbs land at min/max
          h("div", { class: "vz-rail" }),
          // the marker's reference box shares the slider's inset span, so the
          // marker stays centered on the value point
          h("div", { class: "vz-marker-inset" },
            h("div", {
              class: "vz-marker",
              style: markerPct != null ? { left: markerPct + "%" } : { display: "none" },
            }),
          ),
          // the slider insets itself within the lane; the library's base
          // fills it, so thumb centers travel exactly the inset span
          h("div", { class: "vz-slider", ref: sliderRef, disabled: !enabled || undefined }),
        ),
        h("div", { class: "vz-lane vz-lane-current" },
          h("div", {
            class: "vz-current",
            style: markerPct != null ? { left: markerPct + "%" } : { display: "none" },
          }, markerPct != null ? (relative ? "X" : fmt(current)) : ""),
        ),
      ),
    ),
    h("div", { class: "vz-row-inc" },
      h("button", {
        class: "vz-step-btn", title: "smaller step", disabled: !enabled || undefined,
        onClick: () => commitInc(Math.max(fineStep, increment / 2)),
      }, "−"),
      h("input", {
        type: "number", class: "vz-row-inc-input",
        value: String(increment), step: String(fineStep), min: String(fineStep),
        disabled: !enabled || undefined,
        onChange: (e) => commitInc(parseFloat(e.target.value) || param.defaultInc),
      }),
      h("button", {
        class: "vz-step-btn", title: "larger step", disabled: !enabled || undefined,
        onClick: () => commitInc(increment * 2),
      }, "+"),
    ),
  );
}
