// Pure discovery membership. Explicit selections and resource reads are not candidates.
import { compileFilter, normalizeFilter } from "./feed-filter-model.mjs";
import { inFolder } from "/shared/entry-path.mjs";
export { inFolder };

export function judgmentVisible(judgment, { downvoteHides = true, revealThumbedDown = false, hideUp = false } = {}, { downOverride = false } = {}) {
  if (hideUp && judgment?.vote === "up") return false;
  if (judgment?.vote !== "down") return true;
  if (!downvoteHides) return true;
  return !!revealThumbedDown || !!downOverride;
}

export function compileVisibility({ prefs, filter, folder = "" } = {}) {
  const model = normalizeFilter(filter), matches = compileFilter(model);
  return entry => inFolder(entry.filename, folder) && matches(entry) &&
    judgmentVisible(entry.judgment, prefs, { downOverride: model.down });
}
