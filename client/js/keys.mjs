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

export function makeKeymap() {
  const actions = [];     // { id, defaultKey, key, fn, when, desc, ctx }
  let overrides = {};     // id -> combo

  const km = {
    bind(id, key, fn, { when, desc, ctx } = {}) {
      actions.push({ id, defaultKey: key, key: overrides[id] ?? key, fn, when, desc, ctx });
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
        if (a.when && !a.when(e)) continue;
        a.fn(e);
        return true;
      }
      return false;
    },
  };
  return km;
}
