// client/js/rail.mjs — the feed rail's tape window math, framework-free.
//
// The tape's start index given the wave's position. Holds while the wave is
// inside a quarter-capacity margin of the window (hysteresis — no constant
// sliding); re-centers on the wave past that. Clamps at both ends.

export function tapeWindow(viewLength, capacity, waveStart, waveEnd, tapeStart) {
  if (viewLength <= capacity || capacity <= 0) return 0;
  const maxStart = viewLength - capacity;
  const margin = Math.max(1, Math.floor(capacity / 4));
  if (waveStart >= tapeStart + margin && waveEnd <= tapeStart + capacity - margin) {
    return Math.max(0, Math.min(maxStart, tapeStart));
  }
  const center = Math.floor((waveStart + waveEnd) / 2);
  return Math.max(0, Math.min(maxStart, center - Math.floor(capacity / 2)));
}
