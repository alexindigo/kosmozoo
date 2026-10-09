// Modal-private editable work and owner-issued Run tickets. Catalogue data is
// readonly context; the compiler records consumption as it reads typed leaves.
import { snapshotDraft, sameDraft, createRunId } from "./draft.js";
import { paramDef, defaultRange } from "./graph.mjs";
import { templateLabels, parseSemicolonList, expandTextAxes, permutationPlan,
  resolveRelativeRanges, acknowledgedFields } from "/shared/features/variations/shared.mjs";
import { validOrigin, sameOrigin, validContext, sameContext } from "/shared/source-origin.mjs";

const field = (type, channel, wire = null) => Object.freeze({ type, channel, wire });
export const EDITOR_FIELDS = Object.freeze({
  numeric: Object.freeze({ enabled: field("boolean", "rangeSelections", "enabled"), min: field("number", "ranges", "min"),
    max: field("number", "ranges", "max"), rawIncrement: field("string", "ranges", "increment") }),
  images: Object.freeze({ enabled: field("boolean", "imageSelections", "enabled"), mode: field("mode", "imageParams"),
    file: field("filename", "imageParams"), localFiles: field("files", "imageParams") }),
  enums: Object.freeze({ enabled: field("boolean", "imageSelections", "enabled"), picks: field("strings", "imageParams"), filter: field("string", null) }),
  texts: Object.freeze({ enabled: field("boolean", "imageSelections", "enabled"), text: field("string", "imageParams"), tpl: field("templates", "imageParams") }),
  naming: Object.freeze({ prefix: field("string", "naming"), suffix: field("string", "naming") }),
});
const validValue = (type, value) => {
  if (["boolean", "string"].includes(type)) return typeof value === type;
  if (type === "number") return Number.isFinite(value);
  if (type === "mode") return ["new", "local", "files"].includes(value);
  if (type === "filename") return value === null || typeof value === "string";
  if (type === "strings") return Array.isArray(value) && value.every(item => typeof item === "string");
  if (type === "files") return value === null || Array.isArray(value) && value.every(item => item instanceof File);
  if (type === "templates") return value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(item => typeof item === "string");
  return false;
};
const freeze = value => {
  if (!value || typeof value !== "object" || value instanceof File) return value;
  for (const item of Object.values(value)) freeze(item);
  return Object.freeze(value);
};
const filename = value => typeof value === "string" && value.length > 0 && !/[\\/\x00-\x1f\x7f]/.test(value) && ![".", ".."].includes(value);
const token = id => `_{${id}}`;
const currentValues = catalogue => Object.fromEntries([...(catalogue.params ?? []), ...(catalogue.stringParams ?? []),
  ...(catalogue.enumParams ?? []), ...(catalogue.textParams ?? [])].map(parameter => [parameter.id, parameter.current]));

export function makeVariationEditor({ targets, services, currentOrigin, changed = () => {}, close = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  const groups = new Map(Object.keys(EDITOR_FIELDS).map(domain => [domain, new Map()]));
  const capturedTargets = freeze(snapshotDraft(targets));
  const catalogues = new Map(), issued = new WeakMap();
  const batch = capturedTargets.length > 1;
  let alive = true, editRevision = 0, closeGeneration = 0, deciding = false, active = null, timer = null;
  let result = null, running = false, catalogueReady = false;
  const row = (domain, id) => groups.get(domain)?.get(id);
  const descriptor = (domain, name) => {
    const definition = EDITOR_FIELDS[domain]?.[name];
    if (!definition) throw new Error(`Unclassified editable field: ${domain}.${name}`);
    return definition;
  };
  const notify = () => { if (alive) changed(); };
  const invalidateClose = () => { closeGeneration++; if (timer !== null) clearTimer(timer); timer = null; };
  const seed = (domain, id, metadata, defaults) => {
    if (!alive) return;
    let entry = row(domain, id);
    if (!entry) { entry = { metadata: {}, values: {}, baseline: {}, touched: new Set() }; groups.get(domain).set(id, entry); }
    entry.metadata = freeze(snapshotDraft({ ...entry.metadata, ...metadata }));
    for (const [name, value] of Object.entries(defaults)) {
      const definition = descriptor(domain, name);
      if (!validValue(definition.type, value)) throw new Error(`Invalid default: ${domain}.${name}`);
      if (!entry.touched.has(name)) { entry.values[name] = snapshotDraft(value); entry.baseline[name] = snapshotDraft(value); }
    }
    notify();
  };
  const write = (domain, id, name, value) => {
    const definition = descriptor(domain, name), entry = row(domain, id);
    if (!entry || !validValue(definition.type, value)) throw new Error(`Invalid editable value: ${domain}.${name}`);
    entry.values[name] = snapshotDraft(value); entry.touched.add(name);
  };
  const increment = (entry, values = entry.values) => {
    const raw = values.rawIncrement, value = raw?.trim() ? Number(raw) : NaN;
    return Number.isFinite(value) && value >= entry.metadata.minIncrement ? value : null;
  };
  const view = domain => Object.freeze(Object.fromEntries([...groups.get(domain)].map(([id, entry]) => [id,
    freeze(snapshotDraft({ ...entry.metadata, ...entry.values, ...(domain === "numeric" ? { increment: increment(entry) } : {}) }))])));
  const remaining = () => {
    const output = [];
    for (const [domain, entries] of groups) for (const [id, entry] of entries) for (const name of Object.keys(EDITOR_FIELDS[domain])) {
      if (!sameDraft(entry.values[name], entry.baseline[name])) output.push({ domain, id, field: name });
    }
    return output;
  };
  const getLeaf = path => {
    const [domain, id, name, label] = path, entry = row(domain, id);
    if (!entry) return undefined;
    return label === undefined ? entry.values[name] : entry.values[name]?.[label];
  };
  const captureRows = () => Object.fromEntries([...groups].map(([domain, entries]) => [domain,
    Object.fromEntries([...entries].map(([id, entry]) => [id, { values: snapshotDraft(entry.values), metadata: snapshotDraft(entry.metadata), baseline: snapshotDraft(entry.baseline) }]))]));
  const owns = ticket => alive && issued.has(ticket) && active === ticket;
  const originCurrent = target => validOrigin(target.origin) && sameOrigin(target.origin, currentOrigin(target.host));
  const check = (ticket, target) => {
    if (!owns(ticket)) throw Object.assign(new Error("Operation retired; work was kept"), { stale: true });
    if (!originCurrent(target)) throw Object.assign(new Error("Source origin changed; no follow-up was authorized. Your work has been kept."), { stale: true });
  };
  const physicalMatch = (a, b) => validOrigin(a) && validOrigin(b) && a.address === b.address && a.kind === b.kind && a.epoch === b.epoch;

  // This compiler is the only reader that attaches producer channels to editor
  // leaves. Dirty tracking uses the same declarations, never whole row objects.
  const compile = (snapshot, uploadReceipts = null, preview = false) => {
    const bindings = [], uploads = [], ranges = {}, imageParams = {};
    const read = (domain, id, name, label) => {
      const definition = descriptor(domain, name), entry = snapshot[domain][id];
      const path = label === undefined ? [domain, id, name] : [domain, id, name, label];
      const value = label === undefined ? entry.values[name] : entry.values[name]?.[label];
      if (definition.channel) bindings.push({ channel: definition.channel, id: domain === "naming" ? name : id, path, value: snapshotDraft(value) });
      return value;
    };
    for (const [id, entry] of Object.entries(snapshot.numeric)) {
      const enabled = read("numeric", id, "enabled"); ranges[id] = { enabled };
      if (!enabled) continue;
      for (const [name, definition] of Object.entries(EDITOR_FIELDS.numeric)) if (definition.channel === "ranges") {
        const value = read("numeric", id, name);
        if (name === "rawIncrement") {
          const parsed = increment(entry);
          if (parsed === null && !preview) throw new Error("Enter a valid positive increment; incomplete text has been kept.");
          ranges[id][definition.wire] = parsed ?? entry.metadata.defaultIncrement;
        } else ranges[id][definition.wire] = value;
      }
      if (ranges[id].min > ranges[id].max) throw new Error("Minimum exceeds maximum; your values have been kept.");
      if (batch) ranges[id].clamp = [...entry.metadata.clamp];
    }
    for (const domain of ["images", "enums", "texts"]) for (const [id, entry] of Object.entries(snapshot[domain])) {
      const enabled = read(domain, id, "enabled"); imageParams[id] = { enabled, values: [] };
      if (!enabled) continue;
      if (domain === "images") {
        const mode = read(domain, id, "mode");
        if (mode === "new") { const file = read(domain, id, "file"); if (file) imageParams[id].values = [file]; }
        else {
          const files = read(domain, id, "localFiles") ?? [];
          uploads.push(...files);
          imageParams[id].values = preview ? files.map(file => `${file.name} [local preview]`)
            : files.flatMap(file => uploadReceipts?.has(file) ? [uploadReceipts.get(file).name] : []);
        }
      } else if (domain === "enums") imageParams[id].values = [...read(domain, id, "picks")];
      else {
        const text = read(domain, id, "text"), substitutions = {};
        for (const label of templateLabels(text)) substitutions[label] = parseSemicolonList(read(domain, id, "tpl", label));
        imageParams[id].values = expandTextAxes(text, substitutions);
      }
    }
    return { payload: { ranges, imageParams, prefix: read("naming", "root", "prefix"), suffix: read("naming", "root", "suffix"), ...(batch ? { relative: true } : {}) },
      bindings, uploads: [...new Set(uploads)] };
  };
  const count = (payload, catalogue) => {
    const values = currentValues(catalogue);
    return permutationPlan(batch ? resolveRelativeRanges(payload.ranges, values) : payload.ranges, values, payload.imageParams).total;
  };
  const compatible = ticket => owns(ticket) && ticket.editRevision === editRevision && !deciding &&
    ticket.targets.every(originCurrent) && issued.get(ticket).compiled.bindings.every(binding => {
      if (sameDraft(getLeaf(binding.path), binding.value)) return true;
      // A clean untouched default may have settled since capture. It is not
      // user work and must neither block other adoption nor be rewound.
      const entry = row(binding.path[0], binding.path[1]), name = binding.path[2];
      return !entry.touched.has(name) && sameDraft(entry.values[name], entry.baseline[name]);
    });
  const adopt = (ticket, fields) => {
    for (const binding of issued.get(ticket).compiled.bindings) {
      if (!fields[binding.channel]?.includes(binding.id) || !sameDraft(getLeaf(binding.path), binding.value)) continue;
      const [domain, id, name, label] = binding.path, entry = row(domain, id);
      if (label === undefined) entry.baseline[name] = snapshotDraft(binding.value);
      else entry.baseline[name] = { ...entry.baseline[name], [label]: snapshotDraft(binding.value) };
    }
  };
  const canClose = ticket => compatible(ticket) && ticket.closeGeneration === closeGeneration && issued.get(ticket).adopted && remaining().length === 0;
  const publish = value => { result = Object.freeze(value); notify(); };

  seed("naming", "root", {}, { prefix: "", suffix: "" });
  return {
    rows: view,
    naming: name => row("naming", "root").values[name],
    dirty: () => remaining().length > 0,
    remaining,
    running: () => running,
    result: () => {
      if (!result?.adopted || !remaining().length || result.state === "remaining") return result;
      return { ...result, state: "remaining", text: `submitted ${result.submitted}/${result.total} — newer edits have been kept`, remaining: remaining() };
    },
    ready: () => catalogueReady,
    catalogueFailure(error) { publish({ text: `Catalogue unavailable: ${error.message ?? error}. Your edits have been kept.`, ok: false, state: "unavailable" }); },
    invalidateClose,
    decision(value) { deciding = !!value; notify(); },
    edit(domain, id, name, value) {
      if (!alive || deciding) return false;
      write(domain, id, name, value);
      if (name === "enabled" && ["numeric", "images"].includes(domain)) {
        const current = row("naming", "root").values.suffix;
        write("naming", "root", "suffix", value ? current.includes(token(id)) ? current : current + token(id) : current.split(token(id)).join(""));
      }
      editRevision++; invalidateClose(); notify(); return true;
    },
    range(id, { min, max }) {
      if (!alive || deciding) return false;
      if (!validValue("number", min) || !validValue("number", max) || !row("numeric", id)) throw new Error("Invalid range edit");
      write("numeric", id, "min", min); write("numeric", id, "max", max);
      editRevision++; invalidateClose(); notify(); return true;
    },
    template(id, label, value) {
      if (!alive || deciding) return false;
      if (typeof label !== "string" || !label.length || typeof value !== "string" || !row("texts", id)) throw new Error("Invalid template edit");
      const entry = row("texts", id);
      write("texts", id, "tpl", { ...entry.values.tpl, [label]: value });
      editRevision++; invalidateClose(); notify(); return true;
    },
    installCatalogue(data) {
      if (!alive) return;
      const target = capturedTargets[0];
      if (!validContext(data?.context) || !sameOrigin(data.context.origin, target.origin)) {
        publish({ text: "Source-bound catalogue unavailable; your edits have been kept.", ok: false, state: "unavailable" }); return;
      }
      catalogues.set(target.id, freeze(snapshotDraft(data)));
      const denoise = data.params.find(parameter => parameter.key === "denoise")?.id;
      for (const parameter of data.params) {
        const tuning = paramDef(parameter.id, parameter.current, parameter.integer), defaults = batch ? { min: -tuning.spread, max: tuning.spread } : defaultRange(tuning, parameter.current);
        seed("numeric", parameter.id, { ...parameter, input: parameter.key, label: parameter.title ?? parameter.type,
          minIncrement: 10 ** -tuning.decimals, defaultIncrement: tuning.defaultInc, clamp: tuning.clamp },
        { enabled: parameter.id === denoise, min: defaults.min, max: defaults.max, rawIncrement: String(tuning.defaultInc) });
      }
      if (denoise) {
        const entry = row("naming", "root"), suffix = entry.baseline.suffix;
        seed("naming", "root", {}, { suffix: suffix.includes(token(denoise)) ? suffix : suffix + token(denoise) });
      }
      for (const parameter of data.stringParams ?? []) seed("images", parameter.id,
        { ...parameter, label: parameter.title ?? parameter.type, files: [], filesReady: false },
        { enabled: false, mode: "new", file: null, localFiles: null });
      for (const parameter of data.enumParams ?? []) seed("enums", parameter.id,
        { ...parameter, label: `${parameter.title ?? parameter.type}.${parameter.key}` }, { enabled: false, picks: [parameter.current], filter: "" });
      for (const parameter of data.textParams ?? []) seed("texts", parameter.id,
        { ...parameter, label: `${parameter.title ?? parameter.type}.${parameter.key}` }, { enabled: false, text: parameter.current, tpl: {} });
      catalogueReady = true; notify();
    },
    installInputs(data) {
      if (!alive || !sameOrigin(data?.origin, capturedTargets[0].origin) || !Array.isArray(data.files)) return;
      const files = data.files.map(file => typeof file === "string" ? file : file.name).filter(filename);
      for (const [id] of groups.get("images")) seed("images", id, { files, filesReady: true }, { file: files[0] ?? null });
    },
    preview() {
      if (!catalogueReady) return { n: 0, perImage: 0, anyEnabled: false, exact: false };
      const compiled = compile(captureRows(), null, true), first = catalogues.get(capturedTargets[0].id);
      const perImage = count(compiled.payload, first);
      const exact = !batch && compiled.uploads.length === 0;
      return { n: perImage * capturedTargets.length, perImage, anyEnabled: Object.values(compiled.payload.ranges).some(axis => axis.enabled) || Object.values(compiled.payload.imageParams).some(axis => axis.enabled && axis.values.length), exact };
    },
    async run() {
      if (!alive) return { status: "stale" };
      if (running || deciding) return { status: "busy" };
      if (!catalogueReady) { publish({ text: "Inspecting source context; your edits have been kept.", ok: false, state: "unavailable" }); return { status: "invalid" }; }
      invalidateClose();
      const ticket = Object.freeze({ runId: createRunId(), editRevision, closeGeneration, snapshot: freeze(captureRows()), targets: capturedTargets });
      const operation = { compiled: null, adopted: false, replies: [] };
      issued.set(ticket, operation); active = ticket;
      let submitted = 0, total = 0, countsComplete = true;
      const failures = [], uploads = new Map();
      try {
        operation.compiled = compile(ticket.snapshot);
        if (operation.compiled.uploads.length && new Set(ticket.targets.map(target => target.origin?.address)).size > 1) throw new Error("Local-file variations across different backends are unsupported. Your files and edits have been kept.");
        for (const target of ticket.targets) check(ticket, target);
        running = true; result = null; notify();
        const prepared = new Map();
        for (const target of ticket.targets) {
          check(ticket, target);
          const data = target.id === capturedTargets[0].id ? catalogues.get(target.id) : await services.probe(target);
          check(ticket, target);
          if (!validContext(data?.context) || !sameOrigin(data.context.origin, target.origin)) throw new Error("Source-bound catalogue unavailable; your work has been kept.");
          prepared.set(target.id, data);
        }
        const uploadTarget = ticket.targets[0];
        for (const file of operation.compiled.uploads) {
          check(ticket, uploadTarget);
          try {
            const form = new FormData(); form.append("image", file, file.name);
            const receipt = await services.uploadInput(uploadTarget.host, form, uploadTarget.origin);
            check(ticket, uploadTarget);
            if (!filename(receipt?.name) || !sameOrigin(receipt.origin, uploadTarget.origin)) throw new Error(`${file.name}: upload acknowledgement unavailable; your File was kept`);
            uploads.set(file, freeze(snapshotDraft(receipt)));
          } catch (error) { check(ticket, uploadTarget); failures.push(error.message); }
        }
        operation.compiled = compile(ticket.snapshot, uploads);
        const proofs = [], uploadFailure = failures.length > 0;
        await Promise.all(ticket.targets.map(async target => {
          try {
            check(ticket, target);
            if ([...uploads.values()].some(receipt => !physicalMatch(receipt.origin, target.origin))) throw new Error("Upload resource origin changed; no follow-up was authorized");
            const catalogue = prepared.get(target.id), context = catalogue.context;
            const request = { id: target.id, host: target.host, filename: target.filename, ...snapshotDraft(operation.compiled.payload), context,
              acknowledgement: { version: 2, runId: ticket.runId, requestId: createRunId() } };
            const expectedTotal = count(request, catalogue);
            const response = await services.run(request);
            const data = response.data;
            operation.replies.push({ request, response });
            if (Number.isSafeInteger(data?.submitted) && data.submitted >= 0) submitted += data.submitted;
            if (Number.isSafeInteger(data?.total) && data.total >= 0) total += data.total;
            if (!response.ok || !Number.isSafeInteger(data?.submitted) || !Number.isSafeInteger(data?.total) || data.total <= 0 || data.submitted !== data.total ||
              !Array.isArray(data.errors ?? []) || data.errors?.length) countsComplete = false;
            check(ticket, target);
            if (!response.ok) { failures.push(`${target.filename}: ${data?.error ?? response.text ?? `error ${response.status}`}`); return; }
            const proof = acknowledgedFields(request, data);
            for (const error of Array.isArray(data?.errors) ? data.errors : []) failures.push(error?.error ?? String(error));
            if (!proof || data.total !== expectedTotal || !sameContext(context, data.acknowledgement?.context)) failures.push("submission acknowledgement unavailable; your edits have been kept.");
            else proofs.push(proof);
          } catch (error) { countsComplete = false; failures.push(`${target.filename}: ${error.message}`); }
        }));
        if (!owns(ticket)) return { status: "stale" };
        const complete = !uploadFailure && failures.length === 0 && proofs.length === ticket.targets.length;
        const eligible = complete && compatible(ticket);
        if (eligible) {
          const fields = Object.fromEntries(Object.keys(proofs[0]).map(channel => [channel, proofs[0][channel].filter(id => proofs.every(proof => proof[channel].includes(id)))]));
          adopt(ticket, fields); operation.adopted = true;
        }
        const outstanding = remaining();
        const summary = batch ? `submitted ${submitted}/${total} across ${ticket.targets.length} images` : `submitted ${submitted}/${total}`;
        const reason = failures[0] ?? (!eligible ? deciding ? "leave decision pending; your edits have been kept" : editRevision !== ticket.editRevision ? "newer edits have been kept" : "operation context changed; your edits have been kept"
          : outstanding.length ? "unsubmitted edits remain" : "");
        publish({ text: submitted || total ? summary + (reason ? ` — ${reason}` : "") : reason || "nothing submitted", ok: complete,
          state: eligible ? outstanding.length ? "remaining" : "adopted" : complete ? "kept" : "unavailable", submitted, total, remaining: outstanding, adopted: eligible });
        if (canClose(ticket)) timer = setTimer(() => { timer = null; if (canClose(ticket)) close(); }, 3000);
        return { status: submitted > 0 && countsComplete && !uploadFailure ? "submitted" : "failed", submitted, total, adopted: eligible };
      } catch (error) {
        if (owns(ticket)) publish({ text: error.message, ok: false, state: error.stale ? "stale" : "invalid", submitted, total, remaining: remaining() });
        return { status: owns(ticket) ? error.stale ? "stale" : "invalid" : "stale", submitted, total };
      } finally { if (owns(ticket)) { running = false; notify(); } }
    },
    dispose() { alive = false; invalidateClose(); if (active) issued.delete(active); active = null; },
  };
}
