// Canonical inclusive intervals. Numeric spans are never expanded into items.
const positive = n => Number.isSafeInteger(n) && n > 0;
function dense(a) {
  if (!Array.isArray(a) || Object.getPrototypeOf(a) !== Array.prototype) return false;
  const length = Object.getOwnPropertyDescriptor(a, 'length').value;
  if (Reflect.ownKeys(a).length !== length + 1) return false;
  for (let i = 0; i < length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(a, String(i));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
  }
  return true;
}
export const equalRanges = (a, b) => a.length === b.length && a.every((pair, i) => pair[0] === b[i][0] && pair[1] === b[i][1]);
export function validRanges(ranges, ceiling = Number.MAX_SAFE_INTEGER) {
  if (!dense(ranges)) return false;
  let end = -1;
  for (const pair of ranges) {
    if (!dense(pair) || pair.length !== 2 || !positive(pair[0]) || !positive(pair[1]) ||
        pair[0] > pair[1] || pair[0] <= end + 1 || pair[1] > ceiling) return false;
    end = pair[1];
  }
  return true;
}
export function containsSequence(ranges, n) {
  let lo = 0, hi = ranges.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (ranges[mid][1] < n) lo = mid + 1; else hi = mid; }
  return lo < ranges.length && ranges[lo][0] <= n;
}
export function insertRange(ranges, lo, hi = lo) {
  const out = []; let added = false;
  for (const pair of ranges) {
    if (pair[1] < lo - 1) out.push(pair);
    else if (pair[0] > hi + 1) { if (!added) { out.push([lo, hi]); added = true; } out.push(pair); }
    else { lo = Math.min(lo, pair[0]); hi = Math.max(hi, pair[1]); }
  }
  if (!added) out.push([lo, hi]);
  return out;
}
export function subtractRanges(visible, acknowledged, baseline = 0) {
  const out = []; let j = 0;
  for (const [start, end] of visible) {
    let lo = Math.max(start, baseline + 1);
    if (lo > end) continue;
    while (j < acknowledged.length && acknowledged[j][1] < lo) j++;
    for (let k = j; k < acknowledged.length && acknowledged[k][0] <= end; k++) {
      const [a, b] = acknowledged[k];
      if (a > lo) out.push([lo, Math.min(end, a - 1)]);
      lo = Math.max(lo, b + 1); if (lo > end) break;
    }
    if (lo <= end) out.push([lo, end]);
  }
  return out;
}
