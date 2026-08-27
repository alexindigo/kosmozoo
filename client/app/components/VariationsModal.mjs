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
import { paramDef, defaultRange, fallbackParams } from "../../js/variations.mjs";
import { SliderRow } from "./SliderRow.mjs";

export function VariationsModal({ images, onClose }) {
  const image = images[0];
  // batch = more than one image: ranges become RELATIVE offsets from each
  // image's own current value (resolved by the plugin at run time), and the
  // count shows the total across the whole selection.
  const batch = images.length > 1;
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
      const init = {};
      for (const { id, key, current, integer, type, title } of forGraph) {
        const p = paramDef(id, current, integer);
        // absolute: a value window around the current value; relative
        // (batch): signed offsets around it, default ±spread
        const def = batch ? { min: -p.spread, max: p.spread } : defaultRange(p, current);
        init[id] = {
          enabled: false, min: def.min, max: def.max, increment: p.defaultInc,
          placeholderKey: id,
          current, integer,
          label: title ?? type, // node display title else class_type
          input: key,
        };
      }
      setRows(init);
      setParams(forGraph);
      // Presentation nicety: auto-enable the denoise row when the graph has
      // one — the user lands on the most common single-axis sweep. Matches
      // any node type; "denoise" is the input name, not a node name.
      const denoiseKey = Object.keys(init).find((k) => init[k].input === "denoise");
      if (denoiseKey) {
        init[denoiseKey].enabled = true;
        if (suffixRef.current) suffixRef.current.value = `_{${denoiseKey}}`;
      }
    };
    console.log("[variations] fetching probe for", image.id);
    fetch(`/api/plugins/variations/probe/${encodeURIComponent(image.id)}`)
      .then((r) => {
        console.log("[variations] probe status:", r.status);
        return r.ok ? r.json() : null;
      })
      .then((data) => {
        if (!data?.params) return resolve(fallbackParams(meta));
        resolve(data.params);
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

  // enabled cards first, then by node label + input name
  const ordered = Object.keys(rows).sort((a, b) => {
    const ea = rows[a].enabled ? 0 : 1;
    const eb = rows[b].enabled ? 0 : 1;
    if (ea !== eb) return ea - eb;
    const la = `${rows[a].label}.${rows[a].input}`;
    const lb = `${rows[b].label}.${rows[b].input}`;
    return la.localeCompare(lb);
  });

  // variations count: product of per-param steps. Absolute mode subtracts
  // the current combo; batch subtracts it only when every enabled range
  // actually contains the current value (offset 0).
  let perImage = 1;
  let anyEnabled = false;
  let allContainCurrent = true;
  for (const [key, r] of Object.entries(rows)) {
    if (!r.enabled) continue;
    anyEnabled = true;
    const inc = r.increment || paramDef(key, r.current, r.integer)?.defaultInc || 1;
    perImage *= Math.max(Math.round((r.max - r.min) / inc) + 1, 1);
    if (batch && !(r.min <= 0 && r.max >= 0)) allContainCurrent = false;
  }
  if (anyEnabled && allContainCurrent && perImage > 0) perImage -= 1;
  const n = anyEnabled ? perImage * images.length : 0;

  async function runVariations() {
    setResult(null);
    setRunning(true);
    try {
      const baseRanges = {};
      for (const [key, r] of Object.entries(rowsRef.current)) {
        baseRanges[key] = {
          enabled: r.enabled, min: r.min, max: r.max,
          increment: r.increment, placeholderKey: r.placeholderKey,
          // batch ranges are offsets; the plugin clamps them per image
          ...(batch ? { clamp: paramDef(key, r.current, r.integer)?.clamp } : {}),
        };
      }
      const prefix = prefixRef.current?.value ?? "";
      const suffix = suffixRef.current?.value ?? "";
      let submitted = 0, totalJobs = 0;
      const failed = [];
      await Promise.all(images.map(async (img) => {
        try {
          const res = await fetch("/api/plugins/variations/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: img.id, host: img.host, filename: img.filename,
              ranges: structuredClone(baseRanges),
              prefix, suffix,
              ...(batch ? { relative: true } : {}),
            }),
          });
          const text = await res.text();
          let data;
          try { data = JSON.parse(text); } catch { data = null; }
          if (!res.ok) {
            failed.push(`${img.filename}: ${data?.error ?? text ?? `error ${res.status}`}`);
            return;
          }
          submitted += data.submitted ?? 0;
          totalJobs += data.total ?? 0;
        } catch (e) {
          failed.push(`${img.filename}: ${e.message}`);
        }
      }));
      if (submitted === 0 && totalJobs === 0) {
        setResult({ text: failed.slice(0, 3).join(" · ") || "nothing submitted", ok: false });
        return;
      }
      const summary = batch
        ? `submitted ${submitted}/${totalJobs} across ${images.length} images` +
          (failed.length ? ` (${failed.length} failed)` : "")
        : `submitted ${submitted}/${totalJobs}`;
      setResult({ text: summary, ok: true });
      setTimeout(onClose, 3000);
    } catch (e) {
      setResult({ text: `fetch failed: ${e.message}`, ok: false });
    } finally {
      setRunning(false);
    }
  }

  return h("div", { class: "vz-panel", onClick: (e) => e.stopPropagation() },
      h("div", { class: "vz-title" }, batch
        ? `Generate image variations · applying to ${images.length} images`
        : "Generate image variations"),
      h("div", { class: "vz-body" },
        h("div", { class: "vz-left" },
          h("div", { class: "vz-sliders" },
            params === null
              ? h("div", { class: "vz-loading" }, "inspecting graph…")
              : params.length === 0
                ? h("div", { class: "vz-loading" }, "this graph exposes no varyable parameters")
                : ordered.map((key) => {
                    const r = rows[key];
                    const p = paramDef(key, r.current, r.integer);
                    const cur = r.current ?? null;
                    return h(SliderRow, {
                      key,
                      param: { ...p, label: r.label ? `${r.label}.${r.input}` : p.label },
                      current: cur,
                      defaults: batch ? { min: -p.spread, max: p.spread } : defaultRange(p, cur),
                      enabled: r.enabled,
                      increment: r.increment,
                      placeholderKey: r.placeholderKey,
                      relative: batch,
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
          batch && anyEnabled ? h("div", { class: "vz-count-sub" },
            `${perImage} variants × ${images.length} images`) : null,
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

let mounted = null; // { root, key }

function openModal(images, key) {
  closeAllVariations();
  const root = document.createElement("div");
  root.className = "vz-root";
  root.addEventListener("click", (e) => {
    if (e.target === root) closeAllVariations(); // backdrop closes
  });
  document.body.appendChild(root);
  preactRender(h(VariationsModal, { images, onClose: closeAllVariations }), root);
  mounted = { root, key };
}

// Single-image entry (the card's wand): absolute ranges around that image's
// current value.
export function toggleVariations(_cardEl, image) {
  if (mounted && mounted.key === image.id) {
    closeAllVariations();
    return;
  }
  openModal([image], image.id);
}

// Bulk entry (the bulk bar's wand): RELATIVE sweeps applied to every
// selected image around its own current value — even for a single image,
// since that's the batch affordance.
export function toggleVariationsBulk(images) {
  const key = "batch:" + images.map((i) => i.id).join("|");
  if (mounted && mounted.key === key) {
    closeAllVariations();
    return;
  }
  openModal(images, key);
}

export function closeAllVariations() {
  if (!mounted) return;
  preactRender(null, mounted.root); // unmounts the panel subtree (cleanups run)
  mounted.root.remove();
  mounted = null;
}
