// client/js/chrome.mjs — the chrome registry: every UI affordance hangs off
// one surface, core and plugins alike. Without it every feature is a patch
// on main.mjs; with it the shell is data.
//
// Surfaces:
//   chrome.menuItem({ id, kind, ... })
//       kind "toggle": { label, title, get(), set(v) }
//       kind "action": { label, title, onClick() }
//       kind "custom": { render(rowEl), searchText? }
//   chrome.headerButton({ id, label, title, onClick })
//   chrome.bind(id, key, fn, { when, desc, ctx })
//       — a named action with a rebindable key. Defaults live in code;
//       user overrides persist in settings core.keys; the keys panel edits
//       them live. ids are stable ("lb.vote.up"), plugins namespace theirs.
//   chrome.status.info/error/active/clear — the status stack
//
// Menu, header buttons, and the key dispatcher read the registries; nothing
// else writes them.

import { S, render, onRender } from "./state.mjs";

const $ = (id) => document.getElementById(id);

const menuItems = [];
const headerButtons = [];
const actions = [];     // { id, defaultKey, key, fn, when, desc, ctx }
let keyOverrides = {};  // id -> combo

export const chrome = {
  menuItem: (item) => menuItems.push(item),
  headerButton: (btn) => headerButtons.push(btn),
  bind(id, key, fn, { when, desc, ctx } = {}) {
    actions.push({ id, defaultKey: key, key: keyOverrides[id] ?? key, fn, when, desc, ctx });
  },
  status: { info, error, active, clear },
};

// --- keymap ------------------------------------------------------------------

// A binding is a combo string: "Ctrl+Alt+Shift+Key" (canonical modifier
// order). Bare single printable characters ("h", "?", "=") ignore Shift —
// e.key already carries the shifted glyph — and require the other modifiers
// off. Anything with a modifier matches the exact combo.
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

// Conflict domain: same effective key in the same ctx ("" = global). Bare
// letters conflict case-insensitively ("h" and "H" are one key here).
function signature(key) {
  return /^[a-z]$/i.test(key) && !key.includes("+") ? `letter:${key.toLowerCase()}` : key;
}

export function findConflict(id, combo) {
  const me = actions.find((a) => a.id === id);
  if (!me) return null;
  const sig = signature(combo);
  const clash = actions.find((a) =>
    a.id !== id && (a.ctx ?? "") === (me.ctx ?? "") && signature(a.key) === sig);
  return clash?.id ?? null;
}

export function setKeymap(overrides) {
  keyOverrides = overrides ?? {};
  for (const a of actions) a.key = keyOverrides[a.id] ?? a.defaultKey;
}

export function rebind(id, combo) {
  const a = actions.find((x) => x.id === id);
  if (!a) return { error: `unknown action ${id}` };
  const conflict = findConflict(id, combo);
  if (conflict) return { conflict };
  keyOverrides[id] = combo;
  a.key = combo;
  return { ok: true };
}

export function resetKey(id) {
  const a = actions.find((x) => x.id === id);
  if (a) { delete keyOverrides[id]; a.key = a.defaultKey; }
}

export function resetAllKeys() {
  keyOverrides = {};
  for (const a of actions) a.key = a.defaultKey;
}

export function actionsList() {
  return actions.map(({ id, key, defaultKey, desc, ctx }) => ({
    id, key, defaultKey, desc: desc ?? id, ctx: ctx ?? "global",
    overridden: key !== defaultKey,
  }));
}

// --- status stack --------------------------------------------------------------
// transient: one shared chip, fades 6s after its last update. active: pinned
// chips keyed by id, visible for the activity's duration. error: sticky,
// click to dismiss.

let transientChip = null;
let transientTimer = null;
const activeChips = new Map();

function info(msg) {
  const stack = $("statusStack");
  if (!stack) return;
  if (!transientChip || !transientChip.parentElement) {
    transientChip = document.createElement("div");
    transientChip.className = "statuschip";
    stack.appendChild(transientChip);
  }
  transientChip.textContent = msg;
  transientChip.classList.remove("fade");
  clearTimeout(transientTimer);
  transientTimer = setTimeout(() => {
    transientChip?.classList.add("fade");
    setTimeout(() => { transientChip?.remove(); transientChip = null; }, 700);
  }, 6000);
}

function active(id, msg) {
  const stack = $("statusStack");
  if (!stack) return;
  let el = activeChips.get(id);
  if (!el) {
    el = document.createElement("div");
    el.className = "statuschip active";
    activeChips.set(id, el);
    stack.appendChild(el);
  }
  el.textContent = msg;
}

function clear(id) {
  const el = activeChips.get(id);
  if (el) { el.remove(); activeChips.delete(id); }
}

function error(msg) {
  const stack = $("statusStack");
  if (!stack) return;
  const el = document.createElement("div");
  el.className = "statuschip error";
  el.textContent = msg;
  el.title = "click to dismiss";
  el.addEventListener("click", () => el.remove());
  stack.appendChild(el);
}

// --- key dispatch ---------------------------------------------------------------
// Capture hook (the keys panel listening for a binding) beats typing, which
// beats chrome keys.

let captureHook = null;
export function setCaptureHook(fn) { captureHook = fn; }

export function initKeyDispatch() {
  document.addEventListener("keydown", (e) => {
    if (S.capturing && captureHook) {
      e.preventDefault();
      e.stopPropagation();
      captureHook(e);
      return;
    }
    if (typeof e.target?.matches === "function"
        && e.target.matches("input, textarea, select")) return;
    for (const a of actions) {
      if (!bindingMatches(a.key, e)) continue;
      if (a.when && !a.when(e)) continue;
      e.preventDefault();
      a.fn(e);
      return; // first matching handler wins
    }
  });
}

// --- renderers (the only writers of menu + header buttons) -----------------------

onRender(() => {
  if (typeof document === "undefined") return; // headless unit tests
  const host = $("headerButtons");
  if (!host) return;
  if (host.dataset.n == headerButtons.length) return;
  host.dataset.n = headerButtons.length;
  host.innerHTML = "";
  for (const b of headerButtons) {
    const el = document.createElement("button");
    el.id = b.id;
    el.textContent = b.label;
    if (b.title) el.title = b.title;
    el.addEventListener("click", b.onClick);
    host.appendChild(el);
  }
});

onRender(() => {
  if (typeof document === "undefined") return;
  const menu = $("menu");
  if (!menu) return;
  menu.hidden = !S.menuOpen;
  if (!S.menuOpen) return;
  // rebuild on every open: rows read live state
  menu.innerHTML = "";
  const search = document.createElement("input");
  search.id = "menuSearch";
  search.type = "search";
  search.placeholder = "filter settings…";
  search.spellcheck = false;
  search.value = S.menuFilter ?? "";
  search.addEventListener("input", () => { S.menuFilter = search.value; render(); });
  menu.appendChild(search);
  const rows = document.createElement("div");
  rows.id = "menuRows";
  menu.appendChild(rows);
  const q = (S.menuFilter ?? "").toLowerCase();
  for (const item of menuItems) {
    const hay = (item.label ?? item.searchText ?? item.id).toLowerCase();
    if (q && !hay.includes(q)) continue;
    const row = document.createElement("div");
    row.className = "menurow";
    if (item.kind === "toggle") {
      const label = document.createElement("label");
      label.className = "switchwrap";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = !!item.get();
      box.addEventListener("change", async () => { await item.set(box.checked); render(); });
      const track = document.createElement("span");
      track.className = "track";
      label.append(box, track, document.createTextNode(item.label));
      if (item.title) label.title = item.title;
      row.appendChild(label);
    } else if (item.kind === "action") {
      const b = document.createElement("button");
      b.textContent = item.label;
      if (b.title) b.title = item.title;
      b.addEventListener("click", item.onClick);
      row.appendChild(b);
    } else if (item.kind === "custom") {
      item.render(row);
    }
    rows.appendChild(row);
  }
});

export function toggleMenu() {
  S.menuOpen = !S.menuOpen;
  render();
}
