// Semantic catalog over private model operations. No input/UI dependencies.
const string = (v) => typeof v === "string" && v.length > 0;
const text = (v) => typeof v === "string";
const bool = (v) => typeof v === "boolean";
const number = (v) => Number.isFinite(v);
const oneOf = (...values) => (v) => values.includes(v);
const optional = (test) => (v) => v === undefined || test(v);
const ids = (v) => Array.isArray(v) && v.every(string);
const target = oneOf("current", "selected");
const shape = (fields) => (args) => Object.keys(args).every((key) => key in fields) &&
  Object.entries(fields).every(([key, test]) => test(args[key]));
const side = (v) => !!v && string(v.source ?? v.remote) && string(v.file ?? v.image);
const judgmentIntent = (v) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  if (v.type === "note") return shape({ type: oneOf("note"), sign: oneOf("pos", "neg"), text })(v);
  if (v.type === "toggle") return shape({ type: oneOf("toggle"), field: oneOf("vote", "favorite", "bookmark"), value: optional(oneOf("up", "down")) })(v) &&
    (v.field !== "vote" || ["up", "down"].includes(v.value));
  if (v.type !== "set" || !v.patch || Array.isArray(v.patch) || typeof v.patch !== "object" || !Object.keys(v.patch).length) return false;
  return shape({ type: oneOf("set"), patch: (patch) => Object.entries(patch).every(([key, value]) =>
    key === "vote" ? value == null || ["up", "down"].includes(value) :
    ["favorite", "bookmark"].includes(key) ? value == null || bool(value) :
    key === "notes" ? value == null || (typeof value === "object" && !Array.isArray(value) && Object.entries(value).every(([sign, text]) => ["pos", "neg"].includes(sign) && (text == null || typeof text === "string"))) : false) })(v);
};

export function registerCoreCommands(handles, { ops, state, clipboard = (text) => globalThis.navigator?.clipboard?.writeText(text) }) {
  const add = (id, fields, execute, description = id, files = false) =>
    handles.register({ id, description, validate: typeof fields === "function" ? fields : shape(fields), execute, files });
  // Explicit IDs never fall back. Resolve implicit identity before any writer/await.
  const resolveIds = (args) => {
    if (Object.hasOwn(args, "id")) return [args.id];
    if (Object.hasOwn(args, "ids")) return [...args.ids];
    if (args.target === "current") { const current = state.currentEntry(); return current ? [current.entry.id] : []; }
    if (args.target === "selected") return state.images.filter((image) => state.selected[image.id]).map((image) => image.id);
    return [];
  };
  const identity = { id: optional(string), ids: optional(ids), target: optional(target) };
  const hasIdentity = (args) => shape(identity)(args) && ["id", "ids", "target"].filter((key) => Object.hasOwn(args, key)).length === 1;
  const entry = (id) => state.images[state.imageIdxById().get(id)];
  add("workbench.mode", { mode: oneOf("two-up", "one-up", "split", "difference") }, ({ mode }) => ops.diff.setMode(mode), "comparator view");
  add("workbench.column", (a) => shape({ column: optional(oneOf("feed", "right")), toggle: optional(bool) })(a) &&
    (a.toggle === true ? a.column === undefined : a.column !== undefined && a.toggle === undefined), (a) => ops.diff.setCol(a.toggle ? state.diff.col === "feed" ? "right" : "feed" : a.column));
  add("workbench.lock", (a) => shape({ value: optional(bool), toggle: optional(bool) })(a) &&
    (a.toggle === true ? a.value === undefined : a.value !== undefined && a.toggle === undefined), (a) => ops.diff.setLocked(a.toggle ? !state.diff.locked : a.value));
  add("workbench.step", { direction: oneOf(-1, 1) }, ({ direction }) => ops.diff.step(direction));
  add("workbench.close", {}, () => ops.diff.close());
  add("workbench.open", {}, () => ops.diff.open());
  add("workbench.hide", {}, () => ops.diff.hide());
  add("workbench.openEntry", { id: string }, ({ id }) => {
    const index = state.imageIdxById().get(id);
    return index === undefined ? false : ops.diff.openFromFeed(index);
  });
  add("workbench.pickInput", { source: string, file: string, fromOutput: optional(bool) }, (a) => ops.diff.openInput(a.source, a.file, a.fromOutput));
  add("workbench.pickAnchor", { name: string }, ({ name }) => ops.diff.openFromAnchor(state.anchors.findIndex((anchor) => anchor.name === name)));
  add("workbench.openPair", { left: side, right: optional(side), push: optional(bool) }, (a) => ops.diff.openDiff(a.left, a.right, { push: a.push }));
  const parameters = {
    split: ops.diff.setSplit, activeOpacity: ops.diff.setActiveOpacity,
    absolute: ops.diff.setDiffAbs, opacity: ops.diff.setDiffOpacity, threshold: ops.diff.setDiffThreshold,
  };
  handles.register({ id: "workbench.parameters", validate: (a) => shape({ parameter: oneOf(...Object.keys(parameters)), value: optional((v) => number(v) || bool(v)), toggle: optional(bool) })(a) &&
    (a.parameter === "absolute" ? a.toggle === true || bool(a.value) : number(a.value)),
    execute: (a) => parameters[a.parameter](a.toggle ? !state.diff.diffAbs : a.value) });
  add("keys.panel.toggle", {}, () => ops.keys.togglePanel(), "actions & keys panel");
  add("keys.panel.close", {}, () => ops.keys.closePanel(), "close panel");
  add("keys.capture.cancel", {}, () => ops.keys.cancelCapture());
  handles.register({ id: "judgment.apply", validate: (a) => shape({ ...identity, intent: judgmentIntent })(a) &&
    ["id", "ids", "target"].filter((key) => Object.hasOwn(a, key)).length === 1,
    execute(a) {
      const snapshot = resolveIds(a);
      if (a.id || a.target === "current") return snapshot.length ? ops.judgments.dispatch(snapshot[0], a.intent) : false;
      const tasks = snapshot.map((id) => ops.judgments.dispatch(id, a.intent));
      return Promise.all(tasks).then((results) => {
        if (a.target === "selected") {
          const count = results.filter((result) => result.ok).length;
          const label = a.intent.patch?.vote ? a.intent.patch.vote === "up" ? "up-voted" : "down-voted" : "favorited";
          if (count) ops.status.info(`${count} image${count > 1 ? "s" : ""} ${label}`);
        }
        return results;
      });
    } });
  add("image.download", hasIdentity, (a) => {
    const snapshot = resolveIds(a);
    for (const id of snapshot) ops.images.download(id);
    if (a.target === "selected") ops.status.info(`saving ${snapshot.length} image${snapshot.length > 1 ? "s" : ""}`);
  });
  add("image.delete.request", hasIdentity, (a) => {
    const images = resolveIds(a).map(entry).filter(Boolean).map(({ id, host, filename }) => ({ id, host, filename }));
    if (!images.length) return false;
    return ops.confirm.open(a.id ? { image: images[0] } : { images });
  });
  add("image.delete.confirm", {}, () => {
    const request = state.confirmDelete();
    const images = request?.images ?? (request?.image ? [request.image] : []);
    return images.length ? ops.images.delete([...images]) : false;
  });
  add("image.delete.cancel", {}, () => ops.confirm.close());
  add("selection.set", { id: string, value: bool }, (a) => ops.selected.set(a.id, a.value));
  add("selection.clear", {}, () => ops.bulk.clear());
  add("entry.select", { source: string, file: string }, (a) => ops.current.set(a.source, a.file));
  add("entry.navigate", { source: string, file: string }, (a) => ops.current.navigate(a.source, a.file));
  add("entry.previous", {}, () => ops.current.pop());
  add("entry.copyReference", { id: string }, ({ id }) => {
    const image = entry(id);
    return image ? clipboard(state.referenceName(image)) : false;
  });
  add("source.select", { id: string, options: optional((v) => v && typeof v === "object") }, (a) => ops.hosts.select(a.id, a.options));
  add("source.add", { name: text, address: text }, (a) => ops.hosts.add(a.name, a.address));
  add("source.remove", { id: string }, (a) => ops.hosts.remove(a.id));
  handles.register({ id: "source.attributes", validate: (a) => shape({ id: string, patch: optional((v) => v && shape({ pinned: optional(bool), autoRefresh: optional(bool) })(v)), toggle: optional(oneOf("pinned", "autoRefresh")) })(a) && !!(a.patch || a.toggle),
    execute: (a) => ops.hosts.patch(a.id, a.toggle ? { toggle: a.toggle } : a.patch) });
  add("source.refresh", {}, () => ops.ui.refresh());
  add("source.reload", {}, () => ops.images.reload());
  add("source.folder", { folder: text }, ({ folder }) => ops.folders.select(folder));
  add("source.menu.toggle", {}, () => ops.hosts.toggleMenu());
  add("source.menu.close", {}, () => ops.hosts.closeMenu());
  add("feed.filter", { value: text }, ({ value }) => ops.ui.setFilter(value));
  add("feed.revealEntry", { id: string }, ({ id }) => {
    const index = state.imageIdxById().get(id);
    if (index !== undefined) return ops.feed.restoreToIndex(index);
  });
  add("feed.top", {}, () => ops.feed.scrollTop());
  add("workspace.select", { space: oneOf("details", "anchors") }, ({ space }) => ops.ui.setWorkspace(space));
  add("metadata.layout", { layout: oneOf("split", "rev", "stacked", "stacked-rev") }, ({ layout }) => ops.ui.setInfoLayout(layout));
  add("metadata.group.toggle", { group: string }, ({ group }) => ops.ui.infoGroup.toggle(group));
  add("menu.toggle", {}, () => ops.ui.toggleMenu());
  add("menu.close", {}, () => ops.ui.closeMenu());
  add("prefetch.enabled", { value: bool }, ({ value }) => ops.menu.scraperToggle(value));
  add("prefetch.pause", {}, () => ops.menu.scraperPause());
  add("preference.downvoteHides", { value: bool }, ({ value }) => ops.judgments.setDownvoteHides(value));
  add("preference.deleteAssetsPlus", { value: bool }, ({ value }) => ops.menu.deleteAssetsPlus(value));
  add("preference.revealDown", {}, () => ops.judgments.toggleReveal());
  add("preference.hideUp", {}, () => ops.judgments.toggleHideUp());
  add("anchor.add", { files: (v) => Array.isArray(v) && v.every((file) => typeof File !== "undefined" && file instanceof File) }, ({ files }) => ops.anchors.addFiles(files), "add anchors", true);
  add("anchor.remove", { name: string }, ({ name }) => ops.anchors.remove(name));
  add("anchor.reorder", { name: string, over: string, before: bool }, (a) => ops.anchors.reorder(a.name, a.over, a.before));
  add("anchor.persist", {}, () => ops.anchors.persist());
  add("anchor.info.open", { name: string }, ({ name }) => ops.anchors.showInfo(name, state.anchors.find((a) => a.name === name)?.meta ?? null));
  add("anchor.info.close", {}, () => ops.anchors.closeInfo());
  add("collection.feedback.download", { source: string }, ({ source }) => ops.collections.downloadFeedback(source));
  handles.registerOwned({ id: "workbench.popup.toggle", validate: shape({ control: oneOf("active", "threshold", "mask") }) });
  for (const id of ["workbench.popup.close", "feed.filter.toggle", "feed.filter.close"])
    handles.registerOwned({ id, validate: shape({}) });
}

// Compatibility ports enter the same catalog; internal crosscalls keep using ops.
export function commandFacades(handles, ops, state) {
  const invoke = (id, args) => handles.invoke(id, args);
  const judgment = (id, intent) => {
    try { return invoke("judgment.apply", { id, intent }); }
    catch (error) {
      if (!(error instanceof TypeError)) throw error;
      const message = `judgment failed: ${error.message}`;
      ops.status.error(message);
      return Promise.resolve({ ok: false, error: message });
    }
  };
  const facade = Object.fromEntries(Object.entries(ops).map(([key, value]) => [key, typeof value === "object" ? { ...value } : value]));
  facade.collections.downloadFeedback = (source) => invoke("collection.feedback.download", { source });
  Object.assign(facade.diff, {
    setMode: (mode) => invoke("workbench.mode", { mode }),
    setCol: (column) => invoke("workbench.column", { column }),
    setLocked: (value) => invoke("workbench.lock", { value }),
    step: (direction) => invoke("workbench.step", { direction }),
    open: () => invoke("workbench.open"), hide: () => invoke("workbench.hide"), close: () => invoke("workbench.close"),
    openFromFeed: (index) => state.images[index] ? invoke("workbench.openEntry", { id: state.images[index].id }) : undefined,
    openInput: (source, file, fromOutput = false) => invoke("workbench.pickInput", { source, file, fromOutput }),
    openFromAnchor: (index) => state.anchors[index] ? invoke("workbench.pickAnchor", { name: state.anchors[index].name }) : undefined,
    openDiff: (left, right, { push = false } = {}) => invoke("workbench.openPair", { left, ...(right ? { right } : {}), push }),
  });
  for (const [method, parameter] of Object.entries({ setSplit: "split", setActiveOpacity: "activeOpacity", setDiffAbs: "absolute", setDiffOpacity: "opacity", setDiffThreshold: "threshold" }))
    facade.diff[method] = (value) => invoke("workbench.parameters", { parameter, value });
  delete facade.diff.ensureRightDefault;
  Object.assign(facade.judgments, {
    dispatch: judgment,
    setVote: (id, vote) => judgment(id, { type: "set", patch: { vote } }),
    toggleFavorite: (id) => judgment(id, { type: "toggle", field: "favorite" }),
    toggleBookmark: (id) => judgment(id, { type: "toggle", field: "bookmark" }),
    saveNotes: (id, notes) => judgment(id, { type: "set", patch: { notes } }),
    toggleReveal: () => invoke("preference.revealDown"), toggleHideUp: () => invoke("preference.hideUp"),
    setDownvoteHides: (value) => invoke("preference.downvoteHides", { value }),
  });
  Object.assign(facade.bulk, {
    clear: () => invoke("selection.clear"),
    vote: (vote) => invoke("judgment.apply", { target: "selected", intent: { type: "set", patch: { vote } } }),
    favorite: () => invoke("judgment.apply", { target: "selected", intent: { type: "set", patch: { favorite: true } } }),
    save: () => invoke("image.download", { target: "selected" }),
  });
  facade.images.download = (id) => invoke("image.download", { id });
  facade.images.reload = () => invoke("source.reload");
  delete facade.images.delete;
  facade.selected.set = (id, value) => invoke("selection.set", { id, value });
  Object.assign(facade.confirm, {
    open: (req) => invoke("image.delete.request", req.image ? { id: req.image.id } : { ids: req.images.map((image) => image.id) }),
    close: () => invoke("image.delete.cancel"),
  });
  Object.assign(facade.hosts, {
    select: (id, options) => invoke("source.select", { id, ...(options ? { options } : {}) }),
    add: (name, address) => invoke("source.add", { name, address }), remove: (id) => invoke("source.remove", { id }),
    patch: (id, patch) => invoke("source.attributes", { id, patch }),
    toggleMenu: () => invoke("source.menu.toggle"), closeMenu: () => invoke("source.menu.close"),
  });
  facade.folders.select = (folder) => invoke("source.folder", { folder });
  Object.assign(facade.ui, {
    setFilter: (value) => invoke("feed.filter", { value }), refresh: () => invoke("source.refresh"),
    toggleMenu: () => invoke("menu.toggle"), closeMenu: () => invoke("menu.close"),
    setWorkspace: (space) => invoke("workspace.select", { space }), setInfoLayout: (layout) => invoke("metadata.layout", { layout }),
    infoGroup: { toggle: (group) => invoke("metadata.group.toggle", { group }) }, toggleKeysPanel: () => invoke("keys.panel.toggle"),
  });
  Object.assign(facade.current, { set: (source, file) => invoke("entry.select", { source, file }), navigate: (source, file) => invoke("entry.navigate", { source, file }), pop: () => invoke("entry.previous") });
  facade.feed.scrollTop = () => invoke("feed.top");
  Object.assign(facade.keys, { togglePanel: () => invoke("keys.panel.toggle"), closePanel: () => invoke("keys.panel.close") });
  Object.assign(facade.anchors, {
    addFiles: (files) => invoke("anchor.add", { files: [...files] }), remove: (name) => invoke("anchor.remove", { name }),
    reorder: (name, over, before) => invoke("anchor.reorder", { name, over, before }), persist: () => invoke("anchor.persist"),
    showInfo: (name) => invoke("anchor.info.open", { name }), closeInfo: () => invoke("anchor.info.close"),
  });
  Object.assign(facade.menu, {
    scraperToggle: (value) => invoke("prefetch.enabled", { value }), scraperPause: () => invoke("prefetch.pause"),
    deleteAssetsPlus: (value) => invoke("preference.deleteAssetsPlus", { value }),
  });
  return facade;
}
