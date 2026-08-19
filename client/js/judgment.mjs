// client/js/judgment.mjs — vote / favorite / hidden, three distinct concepts.
//
// spec §3: vote is the decision signal (persisted, never altered by a
// filter), favorite is interesting-in-itself (persisted), hidden is a view
// filter (session). Down-vote hides by default, and that coupling is a
// setting. "Show thumbed-down" is a temporary reveal — never a data deletion
// (the outgoing code deleted every down-vote to achieve the same effect).

import { S, render } from "./state.mjs";
import { api } from "./api.mjs";

const COUPLING_KEY = "core.judgment";

export async function initJudgment() {
  const ns = await api.settings(COUPLING_KEY).catch(() => ({}));
  S.judgment = {
    downvoteHides: ns.downvoteHides ?? true,
    revealThumbedDown: false,   // temporary, session-only
    hideUp: false,              // session: hide thumbed-up (reload restores)
  };
}

// --- vote ------------------------------------------------------------------

export async function setVote(image, vote) {
  // vote: 'up' | 'down' | null
  await api.setJudgment(image.id, { vote });
  if (!image.judgment) image.judgment = {};
  if (vote === null) delete image.judgment.vote; else image.judgment.vote = vote;
  render();
}

export async function toggleFavorite(image) {
  const next = !(image.judgment?.favorite);
  await api.setJudgment(image.id, { favorite: next || null });
  if (!image.judgment) image.judgment = {};
  if (next) image.judgment.favorite = true; else delete image.judgment.favorite;
  render();
}

// --- notes -----------------------------------------------------------------

// Direct save (card textareas debounce + flush themselves and call this).
export async function saveNotes(image, notes) {
  await api.setJudgment(image.id, { notes }).catch(() => {});
  if (!image.judgment) image.judgment = {};
  if (!notes.pos && !notes.neg) delete image.judgment.notes;
  else image.judgment.notes = notes;
}

// Debounced autosave for other surfaces; prune-when-empty is the store's job
// (harvest #13).
const noteTimers = new Map();
export function setNote(image, which, text) {
  // which: 'pos' | 'neg'
  clearTimeout(noteTimers.get(image.id + which));
  noteTimers.set(image.id + which, setTimeout(() => {
    saveNotes(image, { ...(image.judgment?.notes ?? {}), [which]: text });
  }, 400));
}

// --- visibility (filter, not data) ------------------------------------------

// Whether an image is visible given the judgment state. Down-vote hides by
// default (coupling exposed as a setting); the reveal is temporary. "Hide
// thumbed-up" is a session filter — marks survive, reload restores.
export function isVisible(image) {
  if (S.judgment?.hideUp && image.judgment?.vote === "up") return false;
  const down = image.judgment?.vote === "down";
  if (!down) return true;
  if (!S.judgment?.downvoteHides) return true;
  return !!S.judgment?.revealThumbedDown;
}

// "Show thumbed-down" toggles a session flag — the votes are never touched.
export function toggleRevealThumbedDown() {
  S.judgment.revealThumbedDown = !S.judgment.revealThumbedDown;
  render();
  return S.judgment.revealThumbedDown;
}

// "Hide thumbed-up" — the session-only counterpart.
export function toggleHideUp() {
  S.judgment.hideUp = !S.judgment.hideUp;
  render();
  return S.judgment.hideUp;
}

export async function setDownvoteHides(on) {
  S.judgment.downvoteHides = on;
  await api.setSettings(COUPLING_KEY, { downvoteHides: on }).catch(() => {});
  render();
}
