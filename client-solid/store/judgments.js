// Entry-ID intents share one queue; confirmation and read protection are per field.
const fields = new Set(["vote", "favorite", "bookmark", "notes"]);

function normalize(field, value) {
  if (field === "favorite" || field === "bookmark") return value ? true : null;
  if (field === "vote") {
    if (value != null && value !== "up" && value !== "down") throw new Error("invalid vote");
    return value ?? null;
  }
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("invalid notes");
  const notes = Object.fromEntries(Object.entries(value).filter(([, text]) => text != null && text !== ""));
  return Object.keys(notes).length ? notes : null;
}

export function makeJudgments({ entryFor, apply, write, onError }) {
  const writes = new Map();
  const reads = new Set();
  let revision = 0;
  const failed = (message) => {
    onError(message);
    return { ok: false, error: message };
  };

  function recordFor(id, entry) {
    let record = writes.get(id);
    if (!record) {
      // Capture the address, never retain a live image proxy across awaits.
      record = { host: entry.host, filename: entry.filename, fields: {}, held: new Set(), promise: Promise.resolve() };
      writes.set(id, record);
    }
    return record;
  }

  function reclaim(id, record) {
    // Completed history lives only while a draft or an older listing needs it.
    const states = Object.values(record.fields);
    if (record.held.size || states.some((state) => state.active)) return;
    for (const read of reads) {
      if (read.collection === record.host && states.some((state) => state.revision > read.revision)) return;
    }
    writes.delete(id);
  }

  function dispatch(id, intent) {
    let pending, patch, commandRevision;
    try {
      if (typeof id !== "string") throw new Error("entry ID required");
      const entry = entryFor(id);
      pending = writes.get(id);
      if (!entry && !pending?.held.size && !Object.values(pending?.fields ?? {}).some((f) => f.active)) {
        throw new Error(`entry unavailable: ${id}`);
      }
      if (intent?.type === "toggle") {
        const { field, value } = intent;
        if (!["vote", "favorite", "bookmark"].includes(field)) throw new Error("invalid toggle field");
        if (field === "vote" && value !== "up" && value !== "down") throw new Error("vote toggle needs up or down");
        const current = pending?.fields[field]?.active
          ? pending.fields[field].desired
          : normalize(field, entry ? entry.judgment?.[field] : pending.fields[field]?.desired);
        patch = { [field]: field === "vote" ? (current === value ? null : value) : !current };
      } else if (intent?.type === "note") {
        const { sign, text } = intent;
        if ((sign !== "pos" && sign !== "neg") || typeof text !== "string") throw new Error("invalid note intent");
        if (!entry && !pending.fields.notes) throw new Error(`notes unavailable: ${id}`);
        const notes = pending?.fields.notes?.active
          ? pending.fields.notes.desired
          : entry ? entry.judgment?.notes : pending.fields.notes?.desired;
        patch = { notes: { ...notes, [sign]: text } };
      } else if (intent?.type === "set" && intent.patch && typeof intent.patch === "object") {
        patch = intent.patch;
      } else throw new Error("invalid judgment intent");
      patch = Object.fromEntries(Object.entries(patch).map(([field, value]) => {
        if (!fields.has(field)) throw new Error(`invalid judgment field: ${field}`);
        return [field, normalize(field, value)];
      }));
      if (!Object.keys(patch).length) throw new Error("empty judgment patch");
      pending = recordFor(id, entry);
      commandRevision = ++revision;
      for (const [field, value] of Object.entries(patch)) {
        let state = pending.fields[field];
        if (!state?.active) {
          const confirmed = normalize(field, entry ? entry.judgment?.[field] : state?.desired);
          state = pending.fields[field] = { confirmed };
        }
        Object.assign(state, { desired: value, active: true, revision: commandRevision });
      }
      apply(id, patch);
    } catch (error) {
      return Promise.resolve(failed(`judgment failed: ${error.message}`));
    }

    pending.promise = pending.promise.then(async () => {
      let outcome;
      try {
        await write(pending.host, pending.filename, patch);
        for (const [field, value] of Object.entries(patch)) pending.fields[field].confirmed = value;
        outcome = { ok: true };
      } catch (error) {
        outcome = failed(`${Object.keys(patch).join("/")} failed: ${pending.filename}: ${error?.message ?? error}`);
      }
      const settled = {};
      for (const field of Object.keys(patch)) {
        const state = pending.fields[field];
        if (state.revision !== commandRevision) continue;
        state.desired = state.confirmed;
        state.active = false;
        // Also invalidate listings begun DURING this request, not just before it.
        state.revision = ++revision;
        settled[field] = state.desired;
      }
      apply(id, settled);
      reclaim(id, pending);
      return outcome;
    });
    return pending.promise;
  }

  return {
    dispatch,
    retain(id, key) {
      const entry = entryFor(id);
      if (!entry && !writes.get(id)?.fields.notes) return failed(`notes unavailable: ${id}`);
      const record = recordFor(id, entry);
      const notes = record.fields.notes ??= { active: false, revision: 0 };
      if (entry && !notes.active) notes.confirmed = notes.desired = normalize("notes", entry.judgment?.notes);
      record.held.add(key);
      return { ok: true };
    },
    release(id, key) {
      const record = writes.get(id);
      if (!record) return;
      record.held.delete(key);
      reclaim(id, record);
    },
    beginRead(collection) {
      const read = { collection, revision };
      reads.add(read);
      return read;
    },
    endRead(read) {
      if (!reads.delete(read)) return;
      for (const [id, record] of writes) if (record.host === read.collection) reclaim(id, record);
    },
    get size() { return writes.size; },
    overlay(id, judgment, read) {
      let result = judgment;
      for (const [field, state] of Object.entries(writes.get(id)?.fields ?? {})) {
        if (state.active || state.revision > read.revision) {
          if (result === judgment) result = { ...judgment };
          if (state.desired == null) delete result[field];
          else result[field] = structuredClone(state.desired);
        } else {
          state.confirmed = state.desired = normalize(field, judgment?.[field]);
        }
      }
      return result;
    },
  };
}
