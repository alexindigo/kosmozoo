// Metadata is a retained, acknowledged demand lane. The acquisition owner
// supplies admission for wants, reads, publication, node refresh and status.
export function makeMetadata({ acquisition, owns, want, meta, nodes, status,
  setPending, setNodes, setStatus, apply, batch, capture = () => null,
  priorityFor = item => item.priority, now = () => performance.now() }) {
  let context = null, version = 0, retired = false;
  const nodesDirty = new Map();
  let nodeRevision = 0;
  let wantTask = null, pollTask = null, statusTask = null, flushQueued = false;
  let retryTimer = null, pollTimer = null, statusTimer = null, failures = 0, pending = 0;
  const demand = new Map();
  const byId = new Map();
  const lanes = new Map(["full:foreground", "dimensions:foreground", "full:background", "dimensions:background"].map(key => [key, new Set()]));
  let projectionVersion = -1, foreground = new Set();
  const current = owner => !retired && context === owner && owns(owner);
  const signature = item => `${item.interest}:${priorityFor(item)}`;
  const entryForName = name => demand.get(name) ?? { id: `${context.id}:${name}` };

  function index(item) {
    if (item.lane) lanes.get(item.lane).delete(item);
    const next = signature(item);
    item.lane = item.ack === next ? null : next;
    if (item.lane) lanes.get(item.lane).add(item);
  }

  // Projection changes affect only the previous/new foreground identities.
  // Acknowledged library demand stays retained, never rescanned by the pump.
  function syncProjection() {
    const nextVersion = acquisition.windowVersion();
    if (projectionVersion === nextVersion) return;
    const next = new Set(acquisition.foregroundIds());
    for (const id of new Set([...foreground, ...next])) {
      if (foreground.has(id) === next.has(id)) continue;
      for (const item of byId.get(id) ?? []) index(item);
    }
    foreground = next; projectionVersion = nextVersion;
  }

  // One classification rule for every metadata job: its lane follows the
  // identities it serves. Work for an identity in the foreground projection
  // (current, viewport window) is foreground demand and never queues behind
  // background publication; everything else is background.
  function laneOf(items) {
    syncProjection();
    for (const item of items) if (item && foreground.has(item.id)) return "foreground";
    return "background";
  }
  // Acknowledged demand whose result has not been published yet.
  const awaiting = () => { syncProjection(); const out = [];
    for (const id of foreground) for (const item of byId.get(id) ?? []) if (item.ack && !item.delivered) out.push(item);
    return out; };

  function first() {
    syncProjection();
    for (const items of lanes.values()) if (items.size) return items.values().next().value;
  }

  function setContext(next) {
    context = next; version = 0; pending = 0; failures = 0; nodesDirty.clear();
    clearTimeout(retryTimer); clearTimeout(pollTimer); clearTimeout(statusTimer);
    retryTimer = pollTimer = statusTimer = null;
    wantTask = pollTask = statusTask = null; flushQueued = false; demand.clear(); byId.clear();
    for (const items of lanes.values()) items.clear();
    projectionVersion = -1; foreground.clear();
  }

  function observePending(value, owner) {
    if (!current(owner) || typeof value !== "number") return;
    pending = value; setPending(value);
    if (value > 0) { schedulePoll(1000, owner); scheduleStatus(owner); }
    else { clearTimeout(statusTimer); statusTimer = null; }
  }

  function request(images, { interest = "full", priority = "foreground", renew = false } = {}) {
    if (!current(context)) return;
    for (const image of images) {
      if (interest === "dimensions" ? image.width && image.height : image.meta || image.extracted) continue;
      const identity = image.hash ?? "";
      let item = demand.get(image.filename);
      if (!item || item.identity !== identity) {
        if (item) { if (item.lane) lanes.get(item.lane).delete(item); byId.get(item.id)?.delete(item); }
        item = { id: image.id, name: image.filename, identity, interest, priority, ack: null };
        demand.set(image.filename, item);
        if (!byId.has(item.id)) byId.set(item.id, new Set());
        byId.get(item.id).add(item);
      } else {
        if (interest === "full" && item.interest !== "full") { item.interest = "full"; item.delivered = false; }
        if (priority === "foreground") item.priority = "foreground";
        if (renew && item.ack !== null) item.ack = null;
      }
      index(item);
    }
    acquisition.reconcile();
    queueFlush();
  }

  function queueFlush() {
    if (flushQueued || wantTask || retryTimer || !current(context)) return;
    flushQueued = true;
    const owner = context;
    queueMicrotask(() => { if (!current(owner)) return; flushQueued = false; flushWant(owner); });
  }

  function flushWant(owner) {
    if (!current(owner) || wantTask || retryTimer) return;
    if (!first()) return;
    let sent = [], snapshot = null;
    const task = acquisition.submit({ key: Symbol("metadata-want"), resourceClass: "control", priority: () => first()?.lane.split(":")[1] ?? "background",
      valid: () => current(owner) && !!first(), run: () => {
        const head = first(), options = { interest: head.interest, priority: priorityFor(head) };
        const items = [];
        for (const item of lanes.get(head.lane)) {
          items.push(item);
          if (items.length === (options.priority === "foreground" ? 20 : 200)) break;
        }
        sent = items.map(item => ({ item, signature: signature(item) }));
        snapshot = capture(items.map(item => item.name));
        return want(owner.id, items.map(item => item.name), options);
      } });
    wantTask = task;
    task.then(reply => {
      if (!current(owner) || reply?.retired) return;
      for (const { item, signature: accepted } of sent) {
        if (demand.get(item.name) === item && signature(item) === accepted) { item.ack = accepted; index(item); }
      }
      failures = 0;
      observePending(reply.pending, owner);
      // The acknowledgement's known state publishes through the same batches,
      // without moving the delta cursor.
      return publish(reply.items, reply.dims, owner, snapshot);
    }, () => {
      if (!current(owner)) return;
      retryTimer = setTimeout(() => { retryTimer = null; queueFlush(); }, Math.min(1000 * 2 ** failures++, 30000));
    }).finally(() => {
      if (wantTask === task) { wantTask = null; queueFlush(); }
    });
  }

  async function refreshNodes(owner) {
    while (nodesDirty.size && current(owner)) {
      const result = await acquisition.submit({ key: "metadata-nodes", resourceClass: "control",
        priority: () => laneOf([...nodesDirty.keys()].map(entryForName)), valid: () => current(owner),
        run: async ({ current: live, priority }) => {
          const captured = new Map(nodesDirty);
          const registry = await nodes({ priority });
          if (live()) {
            setNodes(registry);
            // A graph landing during this read still needs a later registry.
            for (const [name, revision] of captured) if (nodesDirty.get(name) === revision) nodesDirty.delete(name);
          }
        } });
      if (result?.retired) return;
    }
  }

  async function accept(reply, owner, snapshot = capture()) {
    if (!current(owner)) return;
    if (!reply.changed) { await refreshNodes(owner); return; }
    if (await publish(reply.items, reply.dims, owner, snapshot) === false) return;
    version = reply.v;
  }

  // Bounded, yielding publication of {name: meta} / {name: dims}; false when
  // retired before completion.
  async function publish(itemsByName = {}, dimsByName = {}, owner, snapshot) {
    const unique = [...new Set([...Object.keys(itemsByName ?? {}), ...Object.keys(dimsByName ?? {})])];
    if (!unique.length || !current(owner)) return current(owner);
    // Foreground identities publish first, in the foreground lane.
    syncProjection();
    const isForeground = name => foreground.has(entryForName(name).id);
    const names = [...unique.filter(isForeground), ...unique.filter(name => !isForeground(name))];
    let position = 0;
    while (position < names.length && current(owner)) {
      const result = await acquisition.submit({ key: Symbol("metadata-publication"), resource: false, resourceClass: "control",
        priority: () => laneOf(names.slice(position, position + 200).map(entryForName)),
        valid: () => current(owner), run: () => {
          const started = now();
          batch(() => {
            let count = 0;
            do {
              const name = names[position++];
              if (apply(name, itemsByName?.[name], dimsByName?.[name], owner, snapshot)) nodesDirty.set(name, ++nodeRevision);
              const item = demand.get(name);
              if (item && (item.interest === "full" ? itemsByName?.[name] !== undefined : !!dimsByName?.[name])) item.delivered = true;
              count++;
            } while (position < names.length && count < 200 && now() - started < 8);
          });
        } });
      if (result?.retired) return false;
    }
    if (!current(owner)) return false;
    // Dimension-only landings cannot change the discovered node schema.
    await refreshNodes(owner);
    return true;
  }

  function schedulePoll(delay = 1000, owner = context) {
    if (!current(owner) || pollTimer) return;
    pollTimer = setTimeout(() => { pollTimer = null; poll().catch(() => {}); }, delay);
  }

  function poll({ priority = "background" } = {}) {
    const owner = context;
    if (!current(owner)) return Promise.resolve();
    if (pollTask) return pollTask;
    clearTimeout(pollTimer); pollTimer = null;
    const task = (async () => {
      try {
        const snapshot = capture();
        // A poll is foreground while a foreground identity awaits its result.
        const reply = await acquisition.submit({ key: "metadata-poll", resourceClass: "control",
          priority: () => awaiting().length ? "foreground" : priority, valid: () => current(owner),
          run: ({ priority }) => meta(owner.id, version, { priority }) });
        if (!current(owner) || reply?.retired) return;
        observePending(reply.pending, owner);
        await accept(reply, owner, snapshot);
        if (current(owner) && pending > 0) schedulePoll(1000, owner);
      } catch {
        // A failed read remains an obligation even when last-known pending=0.
        if (current(owner)) schedulePoll(1000, owner);
      }
    })();
    pollTask = task;
    task.finally(() => { if (pollTask === task) pollTask = null; });
    return task;
  }

  function scheduleStatus(owner) {
    if (statusTimer || statusTask || !current(owner)) return;
    statusTimer = setTimeout(() => {
      statusTimer = null;
      if (!current(owner) || pending <= 0) return;
      const task = acquisition.submit({ key: "metadata-status", resourceClass: "control", valid: () => current(owner),
        run: async ({ current: live, priority }) => { const reply = await status({ priority }); if (live()) setStatus(reply); } });
      statusTask = task;
      task.catch(() => {}).finally(() => {
        if (statusTask !== task) return;
        statusTask = null;
        if (current(owner) && pending > 0) scheduleStatus(owner);
      });
    }, 2000);
  }

  return { setContext, request, poll, accept,
    dispose() { setContext(null); retired = true; } };
}
