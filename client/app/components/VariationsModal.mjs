// client/app/components/VariationsModal.mjs — the variations panel: a real
// page-level modal for batch parameter sweeps.
//
// One modal at a time (page-level fixed overlay with backdrop), rendered
// into its own container on document.body — the modal is a page citizen,
// not a child of the app tree. Layout:
//   - Title centered at top
//   - Left: parameter rows (<SliderRow>), enabled cards float to the top
//   - Vertical divider
//   - Right: variations count (big), prefix, suffix, Run
//
// Slider rows are populated once the probe returns — the graph decides
// which parameters have a target node, and only those render. The label
// click inserts the per-graph placeholder key into whichever prefix/suffix
// input was last focused. Prefix/suffix WRAP the original filename basename
// in the submission (they don't replace it).

import { h, render as preactRender, useState, useEffect, useRef } from "../../vendor/preact/vendor.mjs";
import { iconSvg } from "../../js/icons.mjs";
import { PARAM_ORDER, paramDef, defaultRange, fallbackParams } from "../../js/variations.mjs";
import { SliderRow } from "./SliderRow.mjs";

export function VariationsModal({ image, onClose }) {
  const [params, setParams] = useState(null); // null = probing; [] = none
  const [rows, setRows] = useState({});       // key -> { enabled, min, max, increment, placeholderKey }
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null); // { text, ok }
  const prefixRef = useRef(null);
  const suffixRef = useRef(null);
  // Tracks last-focused prefix/suffix input so slider labels can insert
  // {key} placeholders at the cursor.
  const templateTarget = useRef({ input: null, start: 0, end: 0 });

  // callbacks are captured by the rows' mount-once slider effects, so they
  // read live state through a ref instead of a stale closure
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    const meta = image.meta ?? {};
    // The graph is the source of truth: only render sliders for parameters
    // whose target node exists in this image's graph. writeOnly params
    // (widget-only custom seed nodes etc.) are skipped for now — they need
    // a different UX and the user is deferring that.
    const resolve = (forGraph) => {
      console.log("[variations] forGraph:", forGraph.length, "params");
      const init = {};
      for (const { key, label, current } of forGraph) {
        const p = paramDef(key);
        if (!p) continue; // registry doesn't know this param — skip
        const def = defaultRange(p, current);
        init[key] = {
          enabled: false, min: def.min, max: def.max, increment: p.defaultInc,
          // the placeholder key mutates after the probe returns
          // (e.g. denoise -> scheduler:denoise)
          placeholderKey: (label && label !== key) ? label : key,
        };
      }
      // Default-on: denoise is the most common single-axis sweep. The
      // user lands on a sensible starting state; its placeholder token
      // auto-populates the suffix exactly like a manual enable would.
      if (init.denoise) {
        init.denoise.enabled = true;
        if (suffixRef.current) suffixRef.current.value = `_{${init.denoise.placeholderKey}}`;
      }
      setRows(init);
      setParams(forGraph);
    };
    console.log("[variations] fetching probe for", image.id);
    fetch(`/api/plugins/variations/probe/${encodeURIComponent(image.id)}`)
      .then((r) => {
        console.log("[variations] probe status:", r.status);
        return r.ok ? r.json() : null;
      })
      .then((data) => {
        if (!data?.params) return resolve(fallbackParams(meta));
        const forGraph = [];
        for (const key of PARAM_ORDER) {
          const info = data.params[key];
          if (!info || info.writeOnly) continue;
          forGraph.push({ key, label: info.label, current: info.current });
        }
        resolve(forGraph);
      })
      .catch((e) => {
        console.warn("[variations] probe failed:", e);
        resolve(fallbackParams(meta));
      });
  }, []);

  // Esc closes (capture phase: the modal outranks everything under it)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  const onToggle = (key, checked) => {
    setRows((rs) => ({ ...rs, [key]: { ...rs[key], enabled: checked } }));
    // enabling auto-inserts the placeholder token into the suffix;
    // disabling removes it. No trailing underscore — ComfyUI's SaveImage
    // node adds its own separator before the counter.
    const ph = rowsRef.current[key]?.placeholderKey;
    const inp = suffixRef.current;
    if (!ph || !inp) return;
    const token = `_{${ph}}`;
    if (checked) {
      if (!inp.value.includes(token)) inp.value = inp.value + token;
    } else {
      if (inp.value.includes(token)) inp.value = inp.value.split(token).join("");
    }
  };

  const onRange = (key, { min, max }) => {
    setRows((rs) => (rs[key] ? { ...rs, [key]: { ...rs[key], min, max } } : rs));
  };

  const onIncrement = (key, inc) => {
    setRows((rs) => ({ ...rs, [key]: { ...rs[key], increment: inc } }));
  };

  // last-focused template input remembers its selection for label clicks
  const remember = (e) => {
    const inp = e.target;
    templateTarget.current.input = inp;
    templateTarget.current.start = inp.selectionStart ?? inp.value.length;
    templateTarget.current.end = inp.selectionEnd ?? inp.value.length;
  };

  // enabled cards first, registry order within each group
  const keyOrder = new Map(PARAM_ORDER.map((k, i) => [k, i]));
  const ordered = Object.keys(rows).sort((a, b) => {
    const ea = rows[a].enabled ? 0 : 1;
    const eb = rows[b].enabled ? 0 : 1;
    if (ea !== eb) return ea - eb;
    return (keyOrder.get(a) ?? 999) - (keyOrder.get(b) ?? 999);
  });

  // variations count: product of per-param steps, minus the current value
  let total = 1;
  let anyEnabled = false;
  for (const [key, r] of Object.entries(rows)) {
    if (!r.enabled) continue;
    anyEnabled = true;
    const inc = r.increment || paramDef(key)?.defaultInc || 1;
    total *= Math.max(Math.round((r.max - r.min) / inc) + 1, 1);
  }
  if (anyEnabled && total > 0) total -= 1;
  const n = anyEnabled ? total : 0;

  async function runVariations() {
    setResult(null);
    setRunning(true);
    try {
      const ranges = {};
      for (const [key, r] of Object.entries(rowsRef.current)) {
        ranges[key] = {
          enabled: r.enabled, min: r.min, max: r.max,
          increment: r.increment, placeholderKey: r.placeholderKey,
        };
      }
      const res = await fetch("/api/plugins/variations/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: image.id, host: image.host, filename: image.filename,
          ranges,
          prefix: prefixRef.current?.value ?? "",
          suffix: suffixRef.current?.value ?? "",
        }),
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = null; }
      if (!res.ok) {
        setResult({ text: data?.error ?? text ?? `error ${res.status}`, ok: false });
        return;
      }
      setResult({ text: `submitted ${data.submitted}/${data.total}`, ok: true });
      setTimeout(onClose, 3000);
    } catch (e) {
      setResult({ text: `fetch failed: ${e.message}`, ok: false });
    } finally {
      setRunning(false);
    }
  }

  return h("div", { class: "vz-panel", onClick: (e) => e.stopPropagation() },
      h("div", { class: "vz-title" }, "Generate image variations"),
      h("div", { class: "vz-body" },
        h("div", { class: "vz-left" },
          h("div", { class: "vz-sliders" },
            params === null
              ? h("div", { class: "vz-loading" }, "inspecting graph…")
              : params.length === 0
                ? h("div", { class: "vz-loading" }, "this graph exposes no varyable parameters")
                : ordered.map((key) => {
                    const p = paramDef(key);
                    const cur = params.find((x) => x.key === key)?.current ?? null;
                    return h(SliderRow, {
                      key,
                      param: p,
                      current: cur,
                      defaults: defaultRange(p, cur),
                      enabled: rows[key].enabled,
                      increment: rows[key].increment,
                      placeholderKey: rows[key].placeholderKey,
                      onToggle, onRange, onIncrement,
                      templateTarget: templateTarget.current,
                    });
                  }),
          ),
        ),
        h("div", { class: "vz-divider" }),
        h("div", { class: "vz-right" },
          h("div", { class: "vz-rlabel" }, "variations"),
          h("div", {
            class: "vz-count" + (n > 1000 ? " vz-count-hot" : n > 100 ? " vz-count-warn" : ""),
          }, String(n)),
          h("div", { class: "vz-rlabel" }, "prefix"),
          h("input", {
            type: "text", class: "vz-tinput vz-prefix", ref: prefixRef,
            title: "click a slider label to insert its {placeholder}",
            onFocus: remember, onSelect: remember, onKeyUp: remember, onMouseUp: remember, onInput: remember,
          }),
          h("div", { class: "vz-rlabel" }, "suffix"),
          h("input", {
            type: "text", class: "vz-tinput vz-suffix", ref: suffixRef,
            title: "click a slider label to insert its {placeholder} (enabled sliders auto-append)",
            onFocus: remember, onSelect: remember, onKeyUp: remember, onMouseUp: remember, onInput: remember,
          }),
          // spacer pushes Run + error to the BOTTOM of the right column, so
          // the primary action sits opposite the tallest content on the left
          h("div", { class: "vz-rspacer" }),
          h("button", {
            class: "vz-run", disabled: running || undefined, onClick: runVariations,
          }, running ? "Running…" : "Run"),
          h("div", { class: "vz-error" + (result?.ok ? " vz-ok" : "") }, result?.text ?? ""),
        ),
      ),
      h("button", {
        class: "vz-close", title: "close (Esc)", onClick: onClose,
        dangerouslySetInnerHTML: { __html: iconSvg("x", 16) },
      }),
  );
}

// --- single-instance lifecycle on document.body ------------------------------
//
// The backdrop is a dedicated empty div appended to body; the component
// renders the panel inside it. (Rendering straight into body is forbidden:
// Preact recycles a container's pre-existing children as excess DOM and
// would eat #app.) The contract holds: .vz-root directly under BODY, gone
// on close.

let mounted = null; // { root, imageId }

export function toggleVariations(_cardEl, image) {
  if (mounted && mounted.imageId === image.id) {
    closeAllVariations();
    return;
  }
  closeAllVariations();
  const root = document.createElement("div");
  root.className = "vz-root";
  root.addEventListener("click", (e) => {
    if (e.target === root) closeAllVariations(); // backdrop closes
  });
  document.body.appendChild(root);
  preactRender(h(VariationsModal, { image, onClose: closeAllVariations }), root);
  mounted = { root, imageId: image.id };
}

export function closeAllVariations() {
  if (!mounted) return;
  preactRender(null, mounted.root); // unmounts the panel subtree (cleanups run)
  mounted.root.remove();
  mounted = null;
}
