// One per-kind view catalogue for opening defaults, command admission and
// toolbar presentation. Existing mode IDs preserve the meanings of keys1–4.
const view = (mode, key, label, icon) => Object.freeze({ mode, key, label, icon });
const full = view("full", "f", "Full", "full-screen");
const images = Object.freeze([
  full,
  view("two-up", "1", "Two-Up", "view-two-up"),
  view("one-up", "2", "One-Up", "view-one-up"),
  view("split", "3", "Split", "view-split"),
  view("difference", "4", "Difference", "view-difference"),
]);
const videos = Object.freeze([
  full,
  view("two-up", "1", "Split", "view-two-up"),
  view("one-up", "2", "Overlay", "view-one-up"),
  view("split", "3", "Slider", "view-split"),
]);
const audio = Object.freeze([full]);
export const workbenchViews = kind => kind === "video" ? videos : kind === "audio" ? audio : images;
export const defaultWorkbenchView = kind => workbenchViews(kind)[0].mode;

// Control availability and rendering effects are one projection of the viewer
// context. Raw session choices survive surfaces where their controls are absent.
export function workbenchPresentation({ kind, mode, paired, activeOpacity, diffOpacity, differenceReason = null }) {
  const comparison = !!paired && kind !== "audio" && mode !== "full" &&
    workbenchViews(kind).some(view => view.mode === mode);
  const highlight = comparison && mode === "difference" && !differenceReason;
  return {
    comparison,
    activeOpacity: { available: comparison, value: comparison ? activeOpacity : 1 },
    highlightOpacity: { available: highlight, value: highlight ? diffOpacity : 1 },
  };
}

// Resource identity and screen position are independent of the active subject.
// Rendering, hit-testing, controls and directional keys share this contract.
export const sides = Object.freeze({ left: "a", right: "b" });
export const viewerSide = Object.freeze({
  a: Object.freeze({ label: "A", column: "feed" }),
  b: Object.freeze({ label: "B", column: "right" }),
});
export const sideForColumn = column => Object.keys(viewerSide).find(side => viewerSide[side].column === column);
export const columnForSide = side => viewerSide[side].column;

export function workbenchLayout({ mode, subject = sides.left, splitT = .5, paired = true }) {
  const layers = Object.fromEntries(Object.entries(sides).map(([position, side]) => [side, {
    position,
    label: viewerSide[side].label,
    active: side === subject,
    shown: (paired || side === subject) && mode !== "difference" && (mode !== "full" || side === subject),
    front: mode === "one-up" && side === subject,
    clip: paired && mode === "split" ? position : null,
  }]));
  return { ...sides, active: subject, divider: mode === "split" ? splitT : .5, layers };
}
