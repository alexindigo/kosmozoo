import { validItemArrivals, containsSequence, insertRange, subtractRanges, equalRanges } from '/js/api.mjs';

export function makeUnseenItems({ changed = () => {} } = {}) {
  let projection = null, baseline = null, acknowledged = [], unseen = [];
  const compatible = value => value === null || validItemArrivals(value) && (!projection ||
    value.revision > projection.revision && value.sequence >= projection.sequence ||
    value.revision === projection.revision && value.sequence === projection.sequence &&
      value.latestVisibleSeq === projection.latestVisibleSeq && equalRanges(value.visibleRanges, projection.visibleRanges));
  return {
    compatible,
    accept(value) {
      if (value === null || !compatible(value)) return false;
      if (projection?.revision === value.revision) return true;
      if (baseline === null) baseline = value.sequence;
      projection = Object.freeze({ sequence: value.sequence, latestVisibleSeq: value.latestVisibleSeq, revision: value.revision,
        visibleRanges: Object.freeze(value.visibleRanges.map(pair => Object.freeze([...pair]))) });
      unseen = subtractRanges(value.visibleRanges, acknowledged, baseline); changed(); return true;
    },
    acknowledge(sequence) {
      if (!containsSequence(unseen, sequence)) return false;
      acknowledged = insertRange(acknowledged, sequence);
      unseen = subtractRanges(projection.visibleRanges, acknowledged, baseline); changed(); return true;
    },
    isUnseen: sequence => Number.isSafeInteger(sequence) && containsSequence(unseen, sequence),
    hasUnseen: () => unseen.length > 0,
    get projection() { return projection; },
  };
}
