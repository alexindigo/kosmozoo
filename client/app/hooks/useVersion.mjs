// client/app/hooks/useVersion.mjs — the boot bridge.
//
// A Preact component reads the shared `state` object directly; subscribing to
// the legacy render() fan-out bumps a local version so the component re-renders
// whenever any surface calls render(). Cleans up on unmount.

import { useState, useEffect } from "../../vendor/preact/vendor.mjs";
import { onRender } from "../../js/state.mjs";

export function useVersion() {
  const [, setVersion] = useState(0);
  useEffect(() => onRender(() => setVersion((v) => v + 1)), []);
}
