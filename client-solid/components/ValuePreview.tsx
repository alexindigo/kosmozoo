import { createEffect, createMemo, createSignal, createUniqueId, onCleanup, onMount } from "solid-js";
import { makeValuePreview, valuePreviewPlacement } from "../lib/value-preview.js";

// Opt-in plain value presentation. Consumers inject modal/dispatch lifetime
// ports; this component owns only its own native surfaces and measured geometry.
export function ValuePreview(props) {
  let trigger, panel, text;
  const id = `value-preview-${createUniqueId()}`;
  const value = createMemo(() => String(props.value ?? "")), available = createMemo(() => !!props.available);
  const [open, setOpen] = createSignal(false), [placed, setPlaced] = createSignal(null);
  const lifetime = makeValuePreview({ show: setOpen });
  const dismiss = () => { lifetime.dismiss(); panel?.hidePopover(); setPlaced(null); };
  onCleanup(() => lifetime.dispose());
  onMount(() => onCleanup(props.registerEditor({ suspend: dismiss, resume() {} })));
  createEffect(() => { value(); available(); dismiss(); });
  const enter = key => { if (available()) lifetime.hold(key, true, true); };
  const leave = key => lifetime.hold(key, false);
  createEffect(() => {
    if (!open()) { panel?.hidePopover(); return; }
    onCleanup(props.registerPopup(dismiss));
    let frame = null, alive = true;
    const update = () => {
      frame = null;
      if (!alive || !trigger.isConnected || !trigger.getClientRects().length) { dismiss(); return; }
      const box = trigger.getBoundingClientRect();
      // Own text measurements only. Popup resize is not a placement input.
      const geometry = valuePreviewPlacement(box, { width: innerWidth, height: innerHeight },
        { width: 480, height: Math.min(360, text.scrollHeight + 32), minHeight: 48 });
      if (!geometry) { dismiss(); return; }
      setPlaced(geometry);
      if (!panel.matches(":popover-open")) panel.showPopover();
    };
    const schedule = () => { if (alive && frame === null) frame = requestAnimationFrame(update); };
    const scroll = event => { if (event.target === document || event.target === window || event.target?.contains?.(trigger)) schedule(); };
    const selection = () => {
      const selected = window.getSelection();
      lifetime.hold("selection", !!selected && !selected.isCollapsed && (text.contains(selected.anchorNode) || text.contains(selected.focusNode)));
    };
    const up = () => { selection(); leave("drag"); };
    const observer = new ResizeObserver(schedule); observer.observe(trigger);
    window.addEventListener("resize", schedule, { passive: true });
    window.addEventListener("scroll", scroll, { capture: true, passive: true });
    document.addEventListener("selectionchange", selection);
    document.addEventListener("pointerup", up); document.addEventListener("pointercancel", up);
    schedule();
    onCleanup(() => {
      alive = false; if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect(); window.removeEventListener("resize", schedule); window.removeEventListener("scroll", scroll, true);
      document.removeEventListener("selectionchange", selection); document.removeEventListener("pointerup", up); document.removeEventListener("pointercancel", up);
    });
  });
  return <>
    <span ref={trigger} class={`single-line-text value-preview-trigger ${props.class ?? ""}`} tabindex="0"
      aria-controls={id} aria-expanded={open()} onPointerEnter={() => enter("trigger")} onPointerLeave={() => leave("trigger")}
      onFocus={() => enter("focus-trigger")} onBlur={() => leave("focus-trigger")}>{value()}</span>
    <div ref={panel} id={id} popover="manual" class="value-preview" classList={{ "value-preview-above": placed()?.side === "above" }}
      style={{ left: `${placed()?.left ?? 0}px`, top: `${placed()?.top ?? 0}px`, width: `${placed()?.width ?? 480}px`, height: `${placed()?.height ?? 360}px`, "--value-preview-notch": `${placed()?.notch ?? 0}px` }}
      onPointerEnter={() => enter("panel")} onPointerLeave={() => leave("panel")}
      onFocusIn={() => enter("focus-panel")} onFocusOut={event => { if (!panel.contains(event.relatedTarget)) leave("focus-panel"); }}
      onPointerDown={event => { if (event.button === 0) lifetime.hold("drag", true); }}>
      <svg aria-hidden="true" class="value-preview-shape" width="100%" height="100%"><path d={placed()?.path ?? ""} /></svg>
      <div ref={text} class="value-preview-text" tabindex="0">{value()}</div>
    </div>
  </>;
}
