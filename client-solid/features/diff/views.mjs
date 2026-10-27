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
