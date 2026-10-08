// SliderRow-private terminal adaptation for the vendored noUiSlider event contract.
// References: nouislider.mjs getActions/fixEvent/eventStart/eventEnd/disable/enable.
// A synthetic terminal retires widget listeners; only a genuine terminal releases
// the physical-gesture quarantine. No widget values are written here.
export function makeSliderGesture(element, { gate, onRetire = () => {} }) {
  const win = element.ownerDocument.defaultView;
  const pointer = !!win.navigator.pointerEnabled;
  const msPointer = !!win.navigator.msPointerEnabled;
  const starts = pointer ? ["pointerdown"] : msPointer ? ["MSPointerDown"] : ["mousedown", "touchstart"];
  let candidate = null, active = null, physical = null, suspended = false, enabled = true, adapting = false;
  const synthetic = new WeakSet();
  const sync = () => gate(enabled && !suspended && !active?.retired);
  const onPointer = (event) => { if (!active && event.isTrusted) physical = { id: event.pointerId, type: event.pointerType }; };
  const onStart = (event) => {
    if (!enabled || suspended || active?.retired) return;
    const touch = event.type === "touchstart" ? [...event.touches].find((t) => event.target === t.target || event.target.contains(t.target)) : null;
    candidate = { family: event.type, target: event.target, touch,
      pointerId: event.pointerId ?? physical?.id, x: event.clientX ?? touch?.clientX ?? 0,
      y: event.clientY ?? touch?.clientY ?? 0, retired: false };
  };
  const retire = () => {
    if (!active || active.retired) return;
    active.retired = true;
    sync();
    onRetire();
    let terminal;
    if (active.family === "touchstart") {
      terminal = new win.TouchEvent("touchend", { bubbles: true, cancelable: true, changedTouches: [active.touch], touches: [], targetTouches: [] });
    } else if (active.family === "pointerdown" || active.family === "MSPointerDown") {
      terminal = new win.PointerEvent(active.family === "pointerdown" ? "pointerup" : "MSPointerUp", {
        bubbles: true, cancelable: true, pointerId: active.pointerId, clientX: active.x, clientY: active.y, buttons: 0,
      });
    } else {
      terminal = new win.MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: active.x, clientY: active.y, buttons: 0 });
    }
    synthetic.add(terminal);
    adapting = true;
    try { active.target.dispatchEvent(terminal); } finally { adapting = false; }
  };
  const matches = (event) => {
    if (!active) return false;
    if (event.type.startsWith("touch")) return active.touch && [...event.changedTouches].some((t) => t.identifier === active.touch.identifier);
    if (event.type.toLowerCase().includes("pointer")) return active.pointerId === event.pointerId;
    return active.family === "mousedown" && event.type === "mouseup";
  };
  const onTerminal = (event) => {
    if (synthetic.has(event) || !matches(event)) return;
    const captured = active;
    if (event.type.toLowerCase().includes("cancel")) retire();
    // Preserve retirement through release callbacks, then allow a new gesture.
    queueMicrotask(() => { if (active === captured) { active = null; candidate = null; physical = null; sync(); } });
  };
  const ends = ["pointerup", "pointercancel", "MSPointerUp", "MSPointerCancel", "mouseup", "touchend", "touchcancel"];
  element.addEventListener("pointerdown", onPointer, true);
  for (const name of starts) element.addEventListener(name, onStart, true);
  for (const name of ends) win.addEventListener(name, onTerminal, true);
  return {
    started() { active = candidate; },
    dragging: () => !!active && !active.retired,
    suppressed: () => adapting || suspended || !!active?.retired,
    setEnabled(value) { enabled = value; sync(); },
    suspend() { suspended = true; sync(); retire(); },
    resume() { suspended = false; sync(); },
    dispose() {
      retire();
      element.removeEventListener("pointerdown", onPointer, true);
      for (const name of starts) element.removeEventListener(name, onStart, true);
      for (const name of ends) win.removeEventListener(name, onTerminal, true);
    },
  };
}
