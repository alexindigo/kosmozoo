// client-solid/features/variations/VariationsModal.tsx — the variations
// panel, declarative: the shared Modal portals it to the page level.
//
// Layout: title centered at top; left: parameter rows, LoadImage sweep rows
// first; enabled cards float to the top, the rest follow the info panel's
// own order (registry title, then input); vertical divider;
// right: variations count (big), prefix, suffix, Run.
//
// Slider rows are populated once the probe returns — the graph decides which
// parameters have a target node, and only those render. The label click
// inserts the per-graph placeholder key into whichever prefix/suffix input
// was last focused. Prefix/suffix WRAP the original filename basename in the
// submission (they don't replace it).

import { createSignal, createMemo, createEffect, createResource, onCleanup, For, Show } from "solid-js";
import { iconSvg } from "/js/icons.mjs";
import { paramDef, defaultRange, fallbackParams } from "./graph.mjs";
import { textLines, templateLabels, expandTextAxes, parseSemicolonList } from "/shared/features/variations/shared.mjs";
import { useAppStore } from "../../store/app-store.js";
import { UPLOAD_IMG_EXT } from "../../store/fields.js";
import { SliderRow } from "./SliderRow.js";
import { Modal } from "../../components/Modal.js";
import { snapshotDraft, sameDraft, makeLeaveGuard, focusMemory } from "./draft.js";
import { VariationDiscardConfirmation } from "./VariationDiscardConfirmation.js";

// every label's raw input parsed to its value list (empties kept — they
// substitute the token with "")
const tplParsed = (tpl) => Object.fromEntries(
  Object.entries(tpl ?? {}).map(([k, v]) => [k, parseSemicolonList(v)]),
);

export function VariationsModal() {
  const store = useAppStore();
  // A permitted replacement changes the scalar mount identity, even when the
  // store reconciles the descriptor. Targets are captured for this owner only.
  return (
    <Show
      when={store.state.variations.open ? store.state.variations.session : null}
      keyed
    >
      {(session) => {
        const images = [...store.state.variations.images].map(snapshotDraft);
        return <Modal class="vz-root" closeCommand="variations.close" closeArgs={{ session }}>
          <ModalBody session={session} images={images} />
        </Modal>;
      }}
    </Show>
  );
}

function ModalBody(props) {
  const store = useAppStore();
  const services = store.actions.variations.services;
  const image = props.images[0];
  // batch = more than one image: ranges become RELATIVE offsets from each
  // image's own current value (resolved by the plugin at run time), and the
  // count shows the total across the whole selection.
  const batch = props.images.length > 1;
  const [params, setParams] = createSignal(null); // null = probing; [] = none
  const [strParams, setStrParams] = createSignal([]); // LoadImage sweep axes
  const [imgRows, setImgRows] = createSignal({}); // id -> { enabled, mode, file, files, current, label, localFiles }
  const [enumList, setEnumList] = createSignal([]); // probe enumParams, graph order
  const [enumRows, setEnumRows] = createSignal({}); // id -> { enabled, picks, current, values, label, filter }
  const [textList, setTextList] = createSignal([]); // probe textParams, graph order
  const [textRows, setTextRows] = createSignal({}); // id -> { enabled, text, current, label }
  const [rows, setRows] = createSignal({}); // key -> { enabled, min, max, increment, placeholderKey, ... }
  const [running, setRunning] = createSignal(false);
  const [result, setResult] = createSignal(null); // { text, ok }
  // the auto-close after a successful run must not fire into an unmounted
  // session 
  let closeT = null;
  let alive = true, runIdentity = null;
  const [revision, setRevision] = createSignal(0);
  const [decision, setDecision] = createSignal(null);
  const children = new Set();
  const registerEditor = (capability) => { children.add(capability); return () => children.delete(capability); };
  let restoreFocus = () => {};
  const rememberFocus = (restore) => { restoreFocus = restore; };
  const focus = focusMemory(rememberFocus);
  const invalidateClose = () => { clearTimeout(closeT); closeT = null; };
  const edited = () => { setRevision((value) => value + 1); invalidateClose(); };
  // prefix/suffix are controlled state — the ONLY writers are the signal
  // setters; token ops are pure text transforms owned here, never surgery
  // on a rendered input's .value
  const [prefix, setPrefix] = createSignal("");
  const [suffix, setSuffix] = createSignal("");
  const baseline = { rows: {}, images: {}, enums: {}, texts: {}, prefix: "", suffix: "" };
  const [baselineVersion, bumpBaseline] = createSignal(0);
  const draft = () => snapshotDraft({ rows: rows(), images: imgRows(), enums: enumRows(), texts: textRows(), prefix: prefix(), suffix: suffix() });
  const dirty = createMemo(() => { baselineVersion(); return !sameDraft(draft(), baseline); });
  const guard = makeLeaveGuard({ dirty,
    suspend: () => { for (const child of children) child.suspend(); },
    restore: () => { for (const child of children) child.resume(); restoreFocus(); },
    decision: setDecision, invalidate: invalidateClose });
  onCleanup(store.actions.variations.registerOwner(props.session, { requestLeave: guard.request, requestRun: runVariations }));
  onCleanup(() => { alive = false; runIdentity = null; invalidateClose(); guard.dispose(); });
  const tokenFor = (key) => `_{${key}}`;
  const addToken = (text, key) => text.includes(tokenFor(key)) ? text : text + tokenFor(key);
  const removeToken = (text, key) => text.split(tokenFor(key)).join("");
  // refs exist solely to read the live selection and restore the caret
  // after a label-click insert
  let prefixEl, suffixEl;
  // the input a label click inserts into — ONE focus signal replaces the
  // four-listener tracking on each input ; the label's mousedown
  // preventDefault keeps the focus (and the selection) alive through the
  // click
  const [focused, setFocused] = createSignal(null); // "prefix" | "suffix"
  // a slider label click inserts its {placeholder} at the focused input's
  // selection. The live value+selection are read at click time — direct
  // programmatic sets bypass onInput, so the signal adopts the buffer here,
  // then the write goes through the signal (the only writer). Solid's
  // signal write is synchronous outside a batch, so the caret restores
  // right after it — no microtask hop.
  const onInsertPlaceholder = (key) => {
    const which = focused();
    if (!which) return;
    const el = which === "prefix" ? prefixEl : suffixEl;
    if (!el) return;
    const cur = el.value;
    const start = el.selectionStart ?? cur.length;
    const end = el.selectionEnd ?? cur.length;
    const placeholder = `{${key}}`;
    const next = cur.slice(0, start) + placeholder + cur.slice(end);
    const caret = start + placeholder.length;
    edited();
    if (which === "prefix") setPrefix(next); else setSuffix(next);
    el.focus();
    el.setSelectionRange(caret, caret);
  };

  // probe + input list are RESOURCES : recency and cancellation come
  // from the primitive — no onMount promise chain, no swallowed errors.
  // The graph is the source of truth: only parameters whose target node
  // exists in this image's graph render (writeOnly params — widget-only
  // custom seed nodes etc. — are skipped for now).
  const [probe] = createResource(() => services.probe(image));

  const resolve = (forGraph) => {
    const init = {};
    for (const { id, key, current, integer, type, title } of forGraph) {
      const p = paramDef(id, current, integer);
      // absolute: a value window around the current value; relative
      // (batch): signed offsets around it, default ±spread
      const def = batch ? { min: -p.spread, max: p.spread } : defaultRange(p, current);
      init[id] = {
        enabled: false, min: def.min, max: def.max, increment: p.defaultInc, rawIncrement: String(p.defaultInc),
        placeholderKey: id,
        current, integer, type,
        label: title ?? type, // node display title else class_type
        input: key,
      };
    }
    // Presentation nicety: auto-enable the denoise row when the graph has
    // one — the user lands on the most common single-axis sweep. Matches
    // any node type; "denoise" is the input name, not a node name.
    const denoiseKey = Object.keys(init).find((k) => init[k].input === "denoise");
    if (denoiseKey) {
      init[denoiseKey].enabled = true;
      setSuffix((s) => addToken(s, denoiseKey));
      baseline.suffix = addToken(baseline.suffix, denoiseKey);
    }
    setRows(init);
    baseline.rows = snapshotDraft(init);
    setParams(forGraph);
  };

  let initializedProbe = false;
  createEffect(() => {
    if (probe.loading) return;
    if (initializedProbe) return;
    initializedProbe = true;
    const data = probe();
    if (!data?.params) { resolve(fallbackParams(image.meta ?? {})); bumpBaseline((value) => value + 1); return; }
    resolve(data.params);
    // LoadImage sweep axes: one row per string param, files listed from the
    // host's input dir
    setStrParams(data.stringParams ?? []);
    // enum sweep axes (LoRA names, samplers, …): one row per NODE instance,
    // options exactly as the host publishes them. Probe order = graph order;
    // the display sort happens in orderedItems.
    const eps = data.enumParams ?? [];
    setEnumList(eps);
    const einit = {};
    for (const p of eps) {
      einit[p.id] = {
        enabled: false, picks: [p.current], current: p.current,
        values: p.values, label: `${p.title ?? p.type}.${p.key}`, filter: "",
      };
    }
    setEnumRows(einit);
    baseline.enums = snapshotDraft(einit);
    // text sweep axes (prompts, …): one row per node instance; the values
    // are user-supplied (one per line), pre-filled with the current text.
    // tpl holds the {{label}} substitution inputs' raw text, keyed by label —
    // kept even when a label temporarily leaves the text (an accidental edit
    // doesn't lose the values)
    const tps = data.textParams ?? [];
    setTextList(tps);
    const tinit = {};
    for (const p of tps) {
      tinit[p.id] = {
        enabled: false, text: p.current, current: p.current, tpl: {},
        label: `${p.title ?? p.type}.${p.key}`,
      };
    }
    setTextRows(tinit);
    baseline.texts = snapshotDraft(tinit);
    bumpBaseline((value) => value + 1);
  });

  const [inputFiles] = createResource(
    () => (strParams().length && image.host ? image.host : null),
    (hostName) => services.inputList(hostName),
  );
  let initializedImages = false;
  createEffect(() => {
    const sp = strParams();
    if (!sp.length || inputFiles.loading) return;
    if (initializedImages) return;
    initializedImages = true;
    const files = inputFiles() ?? [];
    const init = {};
    for (const p of sp) {
      init[p.id] = {
        enabled: false, mode: "new", file: files[0] ?? null,
        files, current: p.current, label: p.title ?? p.type,
        localFiles: null, // File[] picked from a local directory
      };
    }
    setImgRows(init);
    baseline.images = snapshotDraft(init);
    bumpBaseline((value) => value + 1);
  });

  const onToggle = (key, checked) => {
    edited();
    setRows((rs) => ({ ...rs, [key]: { ...rs[key], enabled: checked } }));
    // enabling auto-inserts the placeholder token into the suffix;
    // disabling removes it. No trailing underscore — ComfyUI's SaveImage
    // node adds its own separator before the counter.
    const ph = rows()[key]?.placeholderKey;
    if (!ph) return;
    setSuffix((s) => checked ? addToken(s, ph) : removeToken(s, ph));
  };

  const onRange = (key, { min, max }) => {
    edited();
    setRows((rs) => (rs[key] ? { ...rs, [key]: { ...rs[key], min, max } } : rs));
  };

  const onIncrement = (key, inc, rawIncrement) => {
    edited();
    setRows((rs) => ({ ...rs, [key]: { ...rs[key], increment: inc, rawIncrement } }));
  };

  // LoadImage sweep: enabling auto-inserts the {LoadImage.image} token into
  // the suffix (the output name must encode WHICH input image produced it);
  // disabling removes it. Same grammar as the numeric placeholder tokens.
  const onImgToggle = (id, checked) => {
    edited();
    setImgRows((rs) => ({ ...rs, [id]: { ...rs[id], enabled: checked } }));
    setSuffix((s) => checked ? addToken(s, id) : removeToken(s, id));
  };
  const onImgField = (id, field, value) => {
    edited();
    setImgRows((rs) => ({ ...rs, [id]: { ...rs[id], [field]: value } }));
  };

  // enum sweep rows: the master checkbox arms the axis (its picks ride the
  // imageParams channel at run time); the option checkboxes pick the values.
  // The current value starts pre-checked — unchecking it is how the current
  // combo leaves the sweep.
  const onEnumToggle = (id, checked) => {
    edited();
    setEnumRows((rs) => ({ ...rs, [id]: { ...rs[id], enabled: checked } }));
  };
  const onEnumField = (id, field, value) => {
    edited();
    setEnumRows((rs) => ({ ...rs, [id]: { ...rs[id], [field]: value } }));
  };
  const onEnumPick = (id, v, checked) => {
    edited();
    setEnumRows((rs) => {
      const r = rs[id];
      const picks = checked ? [...r.picks, v] : r.picks.filter((x) => x !== v);
      return { ...rs, [id]: { ...r, picks } };
    });
  };

  // text sweep rows: the master checkbox arms the axis; the textarea holds
  // the values to sweep, one per line (pre-filled with the current text)
  const onTextToggle = (id, checked) => {
    edited();
    setTextRows((rs) => ({ ...rs, [id]: { ...rs[id], enabled: checked } }));
  };
  const onTextField = (id, field, value) => {
    edited();
    setTextRows((rs) => ({ ...rs, [id]: { ...rs[id], [field]: value } }));
  };
  const onTextTpl = (id, label, value) => {
    edited();
    setTextRows((rs) => ({ ...rs, [id]: { ...rs[id], tpl: { ...rs[id].tpl, [label]: value } } }));
  };

  // Row order mirrors the info panel: registry title (fallback class_type),
  // then input name; per-instance rows of one type+input keep graph (probe)
  // order, and prompt (CLIPTextEncode) rows sink to the bottom — exactly the
  // info panel's group order. Enabled rows float to the top. Items are plain
  // strings ("num:"/"enum:"/"txt:" + id) so <For> keeps rows mounted.
  const enumById = createMemo(() => new Map(enumList().map((p) => [p.id, p])));
  const textById = createMemo(() => new Map(textList().map((p) => [p.id, p])));
  const orderedItems = createMemo(() => {
    const reg = store.state.nodesRegistry ?? {};
    const titleOf = (type) => reg[type]?.title || type;
    const sinkOf = (type) => +/clip\s*text\s*encode/i.test(type);
    const items = [];
    for (const [key, r] of Object.entries(rows())) {
      items.push({ id: "num:" + key, enabled: !!r.enabled, sort: [sinkOf(r.type), titleOf(r.type), r.input, 0] });
    }
    const erank = new Map(enumList().map((p, i) => [p.id, i]));
    for (const p of enumList()) {
      const r = enumRows()[p.id];
      if (!r) continue;
      items.push({ id: "enum:" + p.id, enabled: !!r.enabled, sort: [sinkOf(p.type), titleOf(p.type), p.key, erank.get(p.id) ?? 0] });
    }
    const trank = new Map(textList().map((p, i) => [p.id, i]));
    for (const p of textList()) {
      const r = textRows()[p.id];
      if (!r) continue;
      items.push({ id: "txt:" + p.id, enabled: !!r.enabled, sort: [sinkOf(p.type), titleOf(p.type), p.key, trank.get(p.id) ?? 0] });
    }
    return items
      .sort((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        const [sa, ta, ia, ra] = a.sort, [sb, tb, ib, rb] = b.sort;
        return sa - sb || ta.localeCompare(tb) || ia.localeCompare(ib) || ra - rb;
      })
      .map((it) => it.id);
  });

  // variations count: product of per-param steps. The engine excludes the
  // exact current combo — subtract it ONLY when EVERY enabled axis sits at
  // its current value. A swept LoadImage axis whose values exclude the
  // current filename makes every numeric combo novel, so nothing is
  // subtracted then.
  const tally = createMemo(() => {
    let perImage = 1;
    let anyEnabled = false;
    let numericCurrentInRange = true;
    for (const [key, r] of Object.entries(rows())) {
      if (!r.enabled) continue;
      anyEnabled = true;
      const inc = r.increment || paramDef(key, r.current, r.integer)?.defaultInc || 1;
      perImage *= Math.max(Math.round((r.max - r.min) / inc) + 1, 1);
      if (batch) {
        // offsets around the image's own value: combo 0 is in the product iff
        // every enabled offset range spans 0 on a step boundary
        if (!(r.min <= 0 && r.max >= 0)) numericCurrentInRange = false;
        else {
          const steps = (0 - r.min) / inc;
          if (Math.abs(steps - Math.round(steps)) > 1e-6) numericCurrentInRange = false;
        }
      } else {
        const cur = r.current;
        if (cur == null || cur < r.min || cur > r.max) numericCurrentInRange = false;
        else {
          const steps = (cur - r.min) / inc;
          if (Math.abs(steps - Math.round(steps)) > 1e-6) numericCurrentInRange = false;
        }
      }
    }
    // LoadImage sweep axes multiply the count; an enabled-but-empty row (a
    // local mode with nothing picked yet) is inert.
    let imagesAtCurrent = true;
    for (const r of Object.values(imgRows())) {
      if (!r.enabled) continue;
      const vals = r.mode === "new" ? (r.file ? [r.file] : []) : (r.localFiles ?? []);
      if (!vals.length) continue;
      anyEnabled = true;
      perImage *= vals.length;
      if (!(r.current && vals.includes(r.current))) imagesAtCurrent = false;
    }
    // enum sweep axes (LoRA names, samplers, …): same math — an enabled row
    // with no picks is inert, and a pick list without the current value
    // makes every numeric combo novel. ("" is a real current value — the
    // checks are != null, not truthy)
    for (const r of Object.values(enumRows())) {
      if (!r.enabled || !r.picks.length) continue;
      anyEnabled = true;
      perImage *= r.picks.length;
      if (!(r.current != null && r.picks.includes(r.current))) imagesAtCurrent = false;
    }
    // text sweep axes (prompts, …): lines × {{label}} cartesian, same math
    // again — the shared expander computes the exact picks (the run payload
    // uses it too, so the count can't drift from what would be submitted)
    for (const r of Object.values(textRows())) {
      if (!r.enabled) continue;
      const vals = expandTextAxes(r.text, tplParsed(r.tpl));
      if (!vals.length) continue;
      anyEnabled = true;
      perImage *= vals.length;
      if (!(r.current != null && vals.includes(r.current))) imagesAtCurrent = false;
    }
    // subtract the current combo only when numeric axes are at current AND
    // every swept image axis includes the current filename
    const excludeCurrent = anyEnabled && numericCurrentInRange && imagesAtCurrent;
    if (excludeCurrent && perImage > 0) perImage -= 1;
    return { n: anyEnabled ? perImage * props.images.length : 0, anyEnabled, perImage };
  });

  async function runVariations() {
    if (!alive) return { status: "stale" };
    if (running() || guard.pending()) return { status: "busy" };
    invalidateClose();
    const captured = draft();
    const targets = props.images.map(snapshotDraft);
    const editRevision = revision();
    const run = {};
    runIdentity = run;
    const ownsRun = () => alive && runIdentity === run;
    if (Object.values(captured.rows).some((row) => row.enabled && (!Number.isFinite(row.increment) || row.increment <= 0))) {
      setResult({ text: "Enter a valid positive increment; incomplete text has been kept.", ok: false });
      return { status: "invalid" };
    }
    const usesLocalFiles = Object.values(captured.images).some((row) => row.enabled && row.mode !== "new" && row.localFiles?.length);
    const backends = new Set(targets.map((target) => store.state.hosts[target.host]?.address ?? target.host));
    if (usesLocalFiles && backends.size > 1) {
      setResult({ text: "Local-file variations across different backends are unsupported. Your files and edits have been kept.", ok: false });
      return { status: "invalid" };
    }
    setResult(null);
    setRunning(true);
    try {
      const baseRanges = {};
      for (const [key, r] of Object.entries(captured.rows)) {
        baseRanges[key] = {
          enabled: r.enabled, min: r.min, max: r.max,
          increment: r.increment, placeholderKey: r.placeholderKey,
          // batch ranges are offsets; the plugin clamps them per image
          ...(batch ? { clamp: paramDef(key, r.current, r.integer)?.clamp } : {}),
        };
      }
      const pfx = captured.prefix;
      const sfx = captured.suffix;
      // LoadImage sweep axes: enabled rows become enum imageParams. A
      // "local directory" row uploads its picked files to the host's input
      // dir first (ComfyUI's LoadImage only reads that dir), then sweeps
      // over the uploaded names.
      const imageParams = {};
      const uploadErrors = [];
      for (const [id, r] of Object.entries(captured.images)) {
        if (!r.enabled) continue;
        let values = [];
        if (r.mode === "new") {
          values = r.file ? [r.file] : [];
        } else {
          for (const f of r.localFiles ?? []) {
            if (!ownsRun()) return { status: "stale" };
            try {
              const form = new FormData();
              form.append("image", f, f.name);
              const d = await services.uploadInput(image.host, form);
              if (!ownsRun()) return { status: "stale" };
              if (d?.name) values.push(d.name);
              else uploadErrors.push(`${f.name}: upload failed`);
            } catch (e) {
              uploadErrors.push(`${f.name}: ${e.message}`);
            }
          }
        }
        if (values.length) imageParams[id] = { enabled: true, values };
      }
      // enum sweep axes ride the same imageParams channel — one
      // { enabled, values } per armed row, values = the row's picks
      if (!ownsRun()) return { status: "stale" };
      for (const [id, r] of Object.entries(captured.enums)) {
        if (!r.enabled || !r.picks.length) continue;
        imageParams[id] = { enabled: true, values: [...r.picks] };
      }
      // text sweep axes too — values = the textarea's lines, {{label}}
      // templates expanded cartesian-style by the shared expander
      for (const [id, r] of Object.entries(captured.texts)) {
        if (!r.enabled) continue;
        const vals = expandTextAxes(r.text, tplParsed(r.tpl));
        if (vals.length) imageParams[id] = { enabled: true, values: vals };
      }
      let submitted = 0, totalJobs = 0;
      const failed = [];
      const engineErrors = uploadErrors.slice();
      let fullSuccess = uploadErrors.length === 0;
      const submit = async (img) => {
        if (!ownsRun()) return;
        const res = await services.run({
          id: img.id, host: img.host, filename: img.filename,
          ranges: structuredClone(baseRanges),
          prefix: pfx, suffix: sfx,
          ...(batch ? { relative: true } : {}),
          ...(Object.keys(imageParams).length ? { imageParams } : {}),
        });
        const data = res.data;
        if (!ownsRun()) return;
        if (!res.ok || !Number.isInteger(data?.submitted) || !Number.isInteger(data?.total) ||
            data.total <= 0 || data.submitted !== data.total || !Array.isArray(data.errors ?? []) || data.errors?.length) fullSuccess = false;
        if (!res.ok) {
          failed.push(`${img.filename}: ${data?.error ?? res.text ?? `error ${res.status}`}`);
          return;
        }
        submitted += Number.isInteger(data?.submitted) ? data.submitted : 0;
        totalJobs += Number.isInteger(data?.total) ? data.total : 0;
        // the engine reports per-permutation failures inline — collect the
        // detail from the SAME response (a second POST would double-submit)
        for (const e of Array.isArray(data?.errors) ? data.errors : []) {
          engineErrors.push(e?.error ?? String(e));
        }
      };
      await Promise.all(targets.map(async (img) => {
        try {
          await submit(img);
        } catch (e) {
          fullSuccess = false;
          failed.push(`${img.filename}: ${e.message}`);
        }
      }));
      if (!ownsRun()) return { status: "stale" };
      const allFailed = submitted === 0 && totalJobs > 0;
      if ((submitted === 0 && totalJobs === 0) || allFailed) {
        const detail = failed[0] ?? engineErrors[0] ?? "nothing submitted";
        setResult({ text: detail, ok: false });
        return { status: "failed" };
      }
      const summary = (batch
        ? `submitted ${submitted}/${totalJobs} across ${props.images.length} images`
        : `submitted ${submitted}/${totalJobs}`)
        + (failed.length ? ` (${failed.length} failed)` : "")
        + (engineErrors.length ? ` — ${engineErrors[0]}` : "");
      setResult({ text: summary, ok: fullSuccess });
      // Counts do not acknowledge field usage: edited configuration stays dirty.
      if (fullSuccess && !dirty() && !guard.pending() && editRevision === revision() && sameDraft(captured, draft())) {
        closeT = setTimeout(() => {
          if (!ownsRun() || guard.pending() || dirty() || editRevision !== revision() || !sameDraft(captured, draft())) return;
          store.handles.invoke("variations.close", { automatic: true, session: props.session });
        }, 3000);
      }
      return { status: fullSuccess ? "submitted" : "failed", submitted, total: totalJobs };
    } catch (e) {
      if (ownsRun()) setResult({ text: `fetch failed: ${e.message}`, ok: false });
      return { status: ownsRun() ? "failed" : "stale" };
    } finally {
      if (ownsRun()) setRunning(false);
    }
  }

  return (
    <div class="vz-panel" data-session={props.session}>
      <div class="vz-editor" inert={!!decision()}>
        <div class="vz-title">
          {batch
            ? `Generate image variations · applying to ${props.images.length} images`
            : "Generate image variations"}
        </div>
        <div class="vz-body">
          <div class="vz-left">
            <div class="vz-sliders">
              {/* LoadImage sweep axes: pick a new image or the full input dir */}
              <For each={strParams()}>
                {(p) => {
                  const r = () => imgRows()[p.id];
                  return (
                    <Show when={r()}>
                      <div class={"vz-imgrow" + (r().enabled ? " on" : "")}>
                        <label class="vz-imgrow-head">
                          <input
                            type="checkbox" class="vz-cb"
                            checked={r().enabled}
                            onChange={(e) => onImgToggle(p.id, e.target.checked)}
                          />
                          <span class="vz-imgrow-label">{`${r().label}.image`}</span>
                          <span class="vz-imgrow-cur" title={r().current}>{r().current}</span>
                        </label>
                        <Show when={r().enabled}>
                          <div class="vz-imgrow-body">
                            <select
                              {...focusMemory(rememberFocus)}
                              class="vz-imgmode" value={r().mode}
                              onChange={(e) => onImgField(p.id, "mode", e.target.value)}
                            >
                              <option value="new">new image…</option>
                              <option value="local">local directory…</option>
                              <option value="files">local files…</option>
                            </select>
                            <Show when={r().mode === "new"}>
                              <select
                                {...focusMemory(rememberFocus)}
                                class="vz-imgfile" value={r().file ?? ""}
                                onChange={(e) => onImgField(p.id, "file", e.target.value)}
                              >
                                <For each={r().files}>{(f) => <option value={f}>{f}</option>}</For>
                              </select>
                            </Show>
                            {/* local directory: whole picked folder; local files: a
 multi-picked subset. Both read into localFiles. */}
                            <Show when={r().mode === "local"}>
                              <FilePick
                                rememberFocus={rememberFocus}
                                inputAttrs={{ class: "vz-imgdirpick", webkitdirectory: true, multiple: true }}
                                label={() => (r().localFiles?.length ? `${r().localFiles.length} files picked` : "pick a folder…")}
                                onPick={(fl) => onImgField(p.id, "localFiles", fl)}
                              />
                            </Show>
                            <Show when={r().mode === "files"}>
                              <FilePick
                                rememberFocus={rememberFocus}
                                inputAttrs={{ class: "vz-imgfilespick", multiple: true, accept: "image/*" }}
                                label={() => (r().localFiles?.length ? `${r().localFiles.length} files picked` : "pick files…")}
                                onPick={(fl) => onImgField(p.id, "localFiles", fl)}
                              />
                            </Show>
                          </div>
                        </Show>
                      </div>
                    </Show>
                  );
                }}
              </For>
              {/* one merged parameter list: enabled cards float to the top,
 the rest follow the info panel's order (enum + numeric rows interleave) */}
              <Show
                when={params() !== null}
                fallback={<div class="vz-loading">inspecting graph…</div>}
              >
                <Show
                  when={orderedItems().length > 0}
                  fallback={<div class="vz-loading">this graph exposes no varyable parameters</div>}
                >
                  <For each={orderedItems()}>
                    {(itemId) => {
                      if (itemId.startsWith("enum:")) {
                        const id = itemId.slice(5);
                        const p = enumById().get(id);
                        return (
                          <Show when={p && enumRows()[id]}>
                            <EnumRow
                              p={p}
                              row={() => enumRows()[id]}
                              onToggle={onEnumToggle}
                              onPick={onEnumPick}
                              onField={onEnumField}
                              rememberFocus={rememberFocus}
                            />
                          </Show>
                        );
                      }
                      if (itemId.startsWith("txt:")) {
                        const id = itemId.slice(4);
                        const p = textById().get(id);
                        return (
                          <Show when={p && textRows()[id]}>
                            <TextRow
                              p={p}
                              row={() => textRows()[id]}
                              onToggle={onTextToggle}
                              onField={onTextField}
                              onTpl={onTextTpl}
                              rememberFocus={rememberFocus}
                            />
                          </Show>
                        );
                      }
                      const key = itemId.slice(4);
                      const row0 = rows()[key];
                      const p = paramDef(key, row0.current, row0.integer);
                      return (
                        <SliderRow
                          param={{ ...p, label: row0.label ? `${row0.label}.${row0.input}` : p.label }}
                          current={() => rows()[key]?.current ?? null}
                          defaults={batch ? { min: -p.spread, max: p.spread } : defaultRange(p, row0.current)}
                          enabled={() => !!rows()[key]?.enabled}
                          increment={() => rows()[key]?.increment}
                          placeholderKey={key}
                          relative={batch}
                          onToggle={onToggle}
                          onRange={onRange}
                          onIncrement={onIncrement}
                          onInsertPlaceholder={onInsertPlaceholder}
                          registerEditor={registerEditor} rememberFocus={rememberFocus}
                        />
                      );
                    }}
                  </For>
                </Show>
              </Show>
            </div>
          </div>
          <div class="vz-divider" />
          <div class="vz-right">
            <div class="vz-rlabel">variations</div>
            <div class={"vz-count" + (tally().n > 1000 ? " vz-count-hot" : tally().n > 100 ? " vz-count-warn" : "")}>{() => String(tally().n)}</div>
            <Show when={batch && tally().anyEnabled}>
              <div class="vz-count-sub">{`${tally().perImage} variants × ${props.images.length} images`}</div>
            </Show>
            <div class="vz-rlabel">prefix</div>
            <input
              type="text" class="vz-tinput vz-prefix" ref={prefixEl}
              value={prefix()}
              title="click a slider label to insert its {placeholder}"
              {...focus} onFocus={(e) => { setFocused("prefix"); focus.onFocus(e); }}
              onInput={(e) => { edited(); setPrefix(e.currentTarget.value); }}
            />
            <div class="vz-rlabel">suffix</div>
            <input
              type="text" class="vz-tinput vz-suffix" ref={suffixEl}
              value={suffix()}
              title="click a slider label to insert its {placeholder} (enabled sliders auto-append)"
              {...focus} onFocus={(e) => { setFocused("suffix"); focus.onFocus(e); }}
              onInput={(e) => { edited(); setSuffix(e.currentTarget.value); }}
            />
            {/* spacer pushes the result + Run to the BOTTOM of the right
 column — the result message sits above the button, centered on it,
 and the button is the column's last element */}
            <div class="vz-rspacer" />
            <div class={"vz-error" + (result()?.ok ? " vz-ok" : "")}>{result()?.text ?? ""}</div>
            <button
              class="vz-run" disabled={running() || undefined} onClick={() => store.handles.invoke("variations.run")}
            >{running() ? "Running…" : "Run"}</button>
          </div>
        </div>
        <button
          class="vz-close" title="close (Esc)" onClick={() => store.handles.invoke("variations.close", { session: props.session })}
          innerHTML={iconSvg("x", 16)}
        />
      </div>
      <Show when={decision()}>
        <VariationDiscardConfirmation owner={props.session} running={running()} onCancel={guard.cancel} onDiscard={guard.discard} />
      </Show>
    </div>
  );
}

// one enum sweep row: master checkbox + label + the orange current value;
// enabled → the host's options as a filterable checkbox list (the current
// value pre-checked and orange-marked). Props convention mirrors SliderRow:
// p is stable per row, row is a GETTER, interactions report through the
// callbacks — the row never reaches into its parent.
function EnumRow(props) {
  const focus = focusMemory(props.rememberFocus);
  const r = () => props.row();
  const filtered = () => {
    const f = r().filter.trim().toLowerCase();
    return f ? r().values.filter((v) => v.toLowerCase().includes(f)) : r().values;
  };
  return (
    <div class={"vz-imgrow vz-enumrow" + (r().enabled ? " on" : "")} data-enum-id={props.p.id}>
      <label class="vz-imgrow-head">
        <input
          type="checkbox" class="vz-cb"
          checked={r().enabled}
          onChange={(e) => props.onToggle(props.p.id, e.target.checked)}
        />
        <span class="vz-imgrow-label">{r().label}</span>
        <span class="vz-imgrow-cur vz-enum-cur" title={r().current}>{r().current}</span>
      </label>
      <Show when={r().enabled}>
        <div class="vz-imgrow-body vz-enum-body">
          <Show when={r().values.length > 10}>
            <input
              {...focus}
              type="text" class="vz-enum-filter" placeholder="filter…"
              value={r().filter}
              onInput={(e) => props.onField(props.p.id, "filter", e.currentTarget.value)}
            />
          </Show>
          <div class="vz-enum-list">
            <For each={filtered()}>
              {(v) => (
                <label class={"vz-enum-opt" + (v === r().current ? " vz-enum-current" : "")}>
                  <input
                    {...focus}
                    type="checkbox" class="vz-cb"
                    checked={r().picks.includes(v)}
                    onChange={(e) => props.onPick(props.p.id, v, e.target.checked)}
                  />
                  <span class="vz-enum-opt-name" title={v}>{v}</span>
                </label>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}

// one text sweep row: master checkbox + label + the orange current value;
// enabled → a textarea holding the values to sweep, one per line (the
// current text pre-filled). Each {{label}} in the text spawns a substitution
// input below the textarea (semicolon-separated values, cartesian-expanded
// at tally/run time). Same props convention as EnumRow/SliderRow.
function TextRow(props) {
  const focus = focusMemory(props.rememberFocus);
  const r = () => props.row();
  return (
    <div class={"vz-imgrow vz-textrow" + (r().enabled ? " on" : "")} data-text-id={props.p.id}>
      <label class="vz-imgrow-head">
        <input
          type="checkbox" class="vz-cb"
          checked={r().enabled}
          onChange={(e) => props.onToggle(props.p.id, e.target.checked)}
        />
        <span class="vz-imgrow-label">{r().label}</span>
        <span class="vz-imgrow-cur vz-enum-cur" title={r().current}>{r().current}</span>
      </label>
      <Show when={r().enabled}>
        <div class="vz-imgrow-body vz-enum-body">
          <textarea
            {...focus}
            class="vz-text-values" rows="4"
            placeholder="one value per line — {{label}} adds a substitution axis"
            value={r().text}
            onInput={(e) => props.onField(props.p.id, "text", e.currentTarget.value)}
          />
          <For each={templateLabels(r().text)}>
            {(lab) => (
              <div class="vz-tpl-row">
                <span class="vz-tpl-label" title={lab}>{lab}</span>
                <input
                  {...focus}
                  type="text" class="vz-tpl-input"
                  value={r().tpl?.[lab] ?? ""}
                  placeholder="values; separated; by; semicolons"
                  onInput={(e) => props.onTpl(props.p.id, lab, e.currentTarget.value)}
                />
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

// one hidden file input + its trigger button : the directory and files
// pickers were copy-paste twins differing only in input attributes)
function FilePick(props) {
  let el;
  return (
    <span class="vz-imglocal">
      <input
        type="file" style="display:none" ref={el}
        {...props.inputAttrs}
        onChange={(e) => {
          props.onPick([...(e.target.files ?? [])].filter((f) => UPLOAD_IMG_EXT.test(f.name)));
        }}
      />
      <button class="vz-imgdirbtn" {...focusMemory(props.rememberFocus)} onClick={() => el?.click()}>{props.label()}</button>
    </span>
  );
}
