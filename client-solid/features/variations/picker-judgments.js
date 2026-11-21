import { cardState } from "../../store/card-state.js";

export const pickerJudgments = [
  { name: "up", label: "Only up-voted" },
  { name: "favorite", label: "Only starred" },
  { name: "bookmark", label: "Only bookmarked" },
];

// Picker discovery only: every requested flag must be present. Visibility,
// source identity and live judgment overlay remain with the candidate owner.
export function matchesPickerJudgments(judgment, filters = {}) {
  const active = cardState(judgment).active;
  return pickerJudgments.every(({ name }) => !filters[name] || active[name]);
}
