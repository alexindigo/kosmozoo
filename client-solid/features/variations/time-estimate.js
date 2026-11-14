// Readonly projection over the same per-image job count as the count preview.
import { fmtGenerationTime } from "../../store/fields.js";

export const knownGenerationTime = value => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function estimateGenerationTime(perImage, timings) {
  const known = timings.filter(knownGenerationTime);
  if (!Number.isSafeInteger(perImage) || perImage <= 0 || !known.length) {
    return { display: "--", milliseconds: null, partial: false };
  }
  const milliseconds = known.reduce((sum, time) => sum + time * perImage, 0);
  if (!Number.isFinite(milliseconds)) return { display: "--", milliseconds: null, partial: false };
  const partial = known.length !== timings.length;
  return { milliseconds, partial, display: `${partial ? "above " : ""}${fmtGenerationTime(milliseconds, { compact: true })}` };
}
