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

function dataOnly(value, seen = new Set()) {
  if (value == null || ["string", "boolean"].includes(typeof value)) return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  const array = Array.isArray(value);
  if (typeof value !== "object" || seen.has(value) || (array ? Object.getPrototypeOf(value) !== Array.prototype :
      Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
    throw new TypeError("Bindings contain data only");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || !Object.hasOwn(descriptors[key], "value") ||
      (!descriptors[key].enumerable && !(array && key === "length"))))
    throw new TypeError("Bindings contain own data properties only");
  if (array && keys.length !== descriptors.length.value + 1) throw new TypeError("Binding arrays must be dense");
  seen.add(value);
  try {
    for (const key of keys) {
      if (array && key !== "length" && (!Number.isInteger(Number(key)) || String(Number(key)) !== key || Number(key) < 0 || Number(key) >= descriptors.length.value))
        throw new TypeError("Binding arrays contain indexed data only");
      dataOnly(descriptors[key].value, seen);
    }
  } finally { seen.delete(value); }
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
      if (Reflect.ownKeys(binding).some((key) => !["id", "key", "command", "args", "route", "ctx", "desc"].includes(key)) ||
          typeof binding.id !== "string" || !binding.id || typeof binding.key !== "string" ||
          typeof binding.command !== "string" || !binding.command || actions.some((a) => a.id === binding.id) ||
          ["desc", "route", "ctx"].some((key) => binding[key] !== undefined && typeof binding[key] !== "string") ||
          (binding.args !== undefined && (!binding.args || typeof binding.args !== "object" || Array.isArray(binding.args))))
        throw new TypeError("Invalid or duplicate binding");
      const description = adapter.describe(binding.command);
      if (typeof description !== "string") throw new TypeError("Command descriptions must be strings");
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
