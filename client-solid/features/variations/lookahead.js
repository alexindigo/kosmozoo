// Pure presentation geometry. Admission and native lifetimes remain with the
// shared display owner; neither velocity nor a band is another scheduler.
export const LOOKAHEAD_TILES = 15;
export const LOOKAHEAD_SECONDS = 0.5;
export const MAX_LOOKAHEAD_TILES = 90;
export const VELOCITY_IDLE_MS = 300;
export const SLOW_ROWS_PER_SECOND = 3;
const SMOOTHING_MS = 100;
export function scrollSample(previous, offset, at) {
  if (!previous) return { offset, at, velocity: 0 };
  const elapsed = at - previous.at;
  if (elapsed <= 0 || offset === previous.offset) return previous;
  const instantaneous = (offset - previous.offset) * 1000 / elapsed;
  const retained = elapsed >= VELOCITY_IDLE_MS || Math.sign(instantaneous) !== Math.sign(previous.velocity) ? 0 : previous.velocity;
  const weight = 1 - Math.exp(-elapsed / SMOOTHING_MS);
  return { offset, at, velocity: retained + weight * (instantaneous - retained) };
}

export function lookaheadBand(sample, at, rowHeight, columns) {
  const velocity = sample && at - sample.at < VELOCITY_IDLE_MS ? sample.velocity : 0;
  const speed = Math.abs(velocity) / rowHeight;
  const extra = speed <= SLOW_ROWS_PER_SECOND ? 0 : speed * LOOKAHEAD_SECONDS * columns;
  const ahead = Math.min(MAX_LOOKAHEAD_TILES, LOOKAHEAD_TILES + Math.ceil(extra));
  const direction = Math.sign(velocity);
  return { direction, above: direction < 0 ? ahead : LOOKAHEAD_TILES, below: direction > 0 ? ahead : LOOKAHEAD_TILES };
}

export function lookaheadRange(range, band, columns) {
  const start = Math.max(0, range.startIndex - Math.ceil(band.above / columns));
  const end = Math.min(range.count - 1, range.endIndex + Math.ceil(band.below / columns));
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => start + i);
}

export function demandOrder(a, b, range, direction) {
  return demandRank(a, range, direction) - demandRank(b, range, direction);
}

export function demandRank(index, range, direction) {
  if (!range) return 0;
  if (index >= range.startIndex && index <= range.endIndex) return index - range.startIndex;
  const ahead = direction < 0 ? index < range.startIndex : index > range.endIndex;
  const distance = index < range.startIndex ? range.startIndex - index : index - range.endIndex;
  return (ahead ? range.count : range.count * 2) + distance;
}
