// client/js/axes.mjs — the three axes as the primary input model.
//
// Keys are the primary input (spec §1): one key cycles composition, one
// cycles alignment, one frames the ROI. Grouped controls display state.
// Availability AND reason derive from each value's declared needs — "why
// won't this engage" is always answerable (verification row 11).
//
// Composition values: flicker (the manual blink — the default), blend,
// split, difference (plugin). Alignment: independent / shared /
// face-anchored (plugin, needs a configured detector service).

import { S, render } from "./state.mjs";
import { compositionModesList } from "./plugins-client.mjs";

// What each axis value needs to be live. need.ok is computed at cycle time;
// when unmet the value is skipped and its reason is surfaced.
function alignmentNeeds(id) {
  if (id !== "face-anchored") return [];
  return [{
    ok: S.detector?.state === "ready",
    reason: S.detector?.state === "unconfigured"
      ? "no detector service configured (plugins.detector.serviceUrl)"
      : `detector ${S.detector?.state ?? "absent"}`,
  }];
}

function compositionNeeds(id) {
  if (id === "difference") {
    const registered = compositionModesList().some((m) => m.id === "difference");
    return [{ ok: registered, reason: "difference plugin not installed" }];
  }
  return [];
}

export const AXES = {
  alignment: ["independent", "shared", "face-anchored"],
  composition: ["flicker", "blend", "split", "difference"],
};

function needsFor(axis, id) {
  return axis === "alignment" ? alignmentNeeds(id) : compositionNeeds(id);
}

export function axisAvailable(axis, id) {
  const unmet = needsFor(axis, id).filter((n) => !n.ok);
  return { ok: unmet.length === 0, reason: unmet[0]?.reason ?? null };
}

// Cycle an exclusive axis, skipping unavailable values and surfacing WHY.
// Returns the new value.
export function cycleAxis(axis, dir = 1) {
  const values = AXES[axis];
  let cur = S.axes[axis];
  let skippedReason = null;
  for (let step = 0; step < values.length; step++) {
    cur = values[(values.indexOf(cur) + dir + values.length) % values.length];
    const a = axisAvailable(axis, cur);
    if (a.ok) {
      S.axes[axis] = cur;
      S.axisReason = skippedReason; // remember what was skipped past
      render();
      return cur;
    }
    skippedReason = `${cur}: ${a.reason}`;
  }
  return S.axes[axis]; // nothing available changed — leave as-is
}

export function axisStatus() {
  const parts = [`align:${S.axes.alignment}`, `comp:${S.axes.composition}`];
  if (S.axisReason) parts.push(`(${S.axisReason})`);
  return parts.join(" ");
}
