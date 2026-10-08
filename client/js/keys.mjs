// client/js/keys.mjs — the rebindable key registry, framework-free.
//
// A binding is a combo string: "Ctrl+Alt+Shift+Key" (canonical modifier
// order). Bare single printable characters ("h", "?", "=") ignore Shift —
// e.key already carries the shifted glyph — and require the other modifiers
// off. Anything with a modifier matches the exact combo.
//
// Conflict domain: same effective key in the same ctx ("" = global). Bare
// letters conflict case-insensitively ("h" and "H" are one key here).

export function comboFromEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.metaKey) mods.push("Meta");
  if (e.shiftKey) mods.push("Shift");
  return [...mods, e.key].join("+");
}

export function bindingMatches(binding, e) {
  if (binding.length === 1 && !binding.includes("+")) {
    return !e.ctrlKey && !e.altKey && !e.metaKey
      && e.key.toLowerCase() === binding.toLowerCase();
  }
  return comboFromEvent(e) === binding;
}

function signature(key) {
  return /^[a-z]$/i.test(key) && !key.includes("+") ? `letter:${key.toLowerCase()}` : key;
}

function dataOnly(value) {
  if (value == null || ["string", "boolean"].includes(typeof value)) return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype))
    throw new TypeError("Bindings contain data only");
  for (const item of Object.values(value)) dataOnly(item);
}

export function makeKeymap(adapter) {
  if (!adapter || typeof adapter.request !== "function" || typeof adapter.describe !== "function")
    throw new TypeError("A keymap requires one input adapter");
  const actions = [];     // data descriptors, never execution callbacks
  let overrides = {};     // id -> combo

  const km = {
    bind(binding, ...legacy) {
      if (legacy.length || !binding || typeof binding !== "object" || Array.isArray(binding))
        throw new TypeError("Use a data binding descriptor");
      dataOnly(binding);
      if (Object.keys(binding).some((key) => !["id", "key", "command", "args", "route", "ctx", "desc"].includes(key)) ||
          !binding.id || typeof binding.key !== "string" || !binding.command || actions.some((a) => a.id === binding.id))
        throw new TypeError("Invalid or duplicate binding");
      const description = adapter.describe(binding.command);
      const copy = structuredClone(binding);
      actions.push({ ...copy, defaultKey: copy.key, key: overrides[copy.id] ?? copy.key, desc: copy.desc ?? description });
    },
    setKeymap(o) {
      overrides = o ?? {};
      for (const a of actions) a.key = overrides[a.id] ?? a.defaultKey;
    },
    rebind(id, combo) {
      const a = actions.find((x) => x.id === id);
      if (!a) return { error: `unknown action ${id}` };
      const conflict = km.findConflict(id, combo);
      if (conflict) return { conflict };
      overrides[id] = combo;
      a.key = combo;
      return { ok: true };
    },
    resetKey(id) {
      const a = actions.find((x) => x.id === id);
      if (a) { delete overrides[id]; a.key = a.defaultKey; }
    },
    resetAll() {
      overrides = {};
      for (const a of actions) a.key = a.defaultKey;
    },
    list() {
      return actions.map(({ id, key, defaultKey, desc, ctx }) => ({
        id, key, defaultKey, desc: desc ?? id, ctx: ctx ?? "global",
        overridden: key !== defaultKey,
      }));
    },
    findConflict(id, combo) {
      const me = actions.find((a) => a.id === id);
      if (!me) return null;
      const sig = signature(combo);
      const clash = actions.find((a) =>
        a.id !== id && (a.ctx ?? "") === (me.ctx ?? "") && signature(a.key) === sig);
      return clash?.id ?? null;
    },
    // dispatch a keydown through the bindings (first match wins, in
    // registration order). Returns true when a binding handled it.
    dispatch(e) {
      for (const a of actions) {
        if (!bindingMatches(a.key, e)) continue;
        if (adapter.request({ id: a.id, command: a.command, args: a.args ?? {}, route: a.route, ctx: a.ctx }) === false) continue;
        return true;
      }
      return false;
    },
  };
  return km;
}
