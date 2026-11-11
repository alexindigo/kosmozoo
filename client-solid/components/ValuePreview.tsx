import { createEffect, createMemo, createSignal, createUniqueId, onCleanup, onMount } from "solid-js";
import { valuePreviewPlacement } from "../lib/value-preview.js";

// Opt-in plain value presentation. Consumers inject modal/dispatch lifetime
// ports; this component owns only its own native surfaces and measured geometry.
export function ValuePreview(props) {
  let owner, trigger, panel, text;
  const id = `value-preview-${createUniqueId()}`;
  const value = createMemo(() => String(props.value ?? "")), available = createMemo(() => !!props.available);
  const [open, setOpen] = createSignal(false), [placed, setPlaced] = createSignal(null);
  const dismiss = () => { setOpen(false); panel?.hidePopover(); setPlaced(null); };
  onCleanup(dismiss);
  onMount(() => onCleanup(props.registerEditor({ suspend: dismiss, resume() {} })));
  createEffect(() => { value(); available(); dismiss(); });
  const enter = () => { if (available()) setOpen(true); };
  createEffect(() => {
    if (!open()) { panel?.hidePopover(); return; }
    onCleanup(props.registerPopup(dismiss));
    let frame = null, alive = true;
    const update = () => {
      frame = null;
      if (!alive || !owner.matches(":hover") || !trigger.isConnected || !trigger.getClientRects().length) { dismiss(); return; }
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
    const observer = new ResizeObserver(schedule); observer.observe(trigger);
    window.addEventListener("resize", schedule, { passive: true });
    window.addEventListener("scroll", scroll, { capture: true, passive: true });
    schedule();
    onCleanup(() => {
      alive = false; if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect(); window.removeEventListener("resize", schedule); window.removeEventListener("scroll", scroll, true);
    });
  });
  return <div ref={owner} class="value-preview-owner" onPointerEnter={enter} onPointerLeave={dismiss}>
    <span ref={trigger} class={`single-line-text value-preview-trigger ${props.class ?? ""}`} tabindex="0"
      aria-controls={id} aria-expanded={open()}>{value()}</span>
    <div ref={panel} id={id} popover="manual" class="value-preview" classList={{ "value-preview-above": placed()?.side === "above" }}
      style={{ left: `${placed()?.left ?? 0}px`, top: `${placed()?.top ?? 0}px`, width: `${placed()?.width ?? 480}px`, height: `${placed()?.height ?? 360}px`, "--value-preview-notch": `${placed()?.notch ?? 0}px`, "--value-preview-gap": `${placed()?.gap ?? 0}px` }}>
      <svg aria-hidden="true" class="value-preview-shape" width="100%" height="100%"><path d={placed()?.path ?? ""} /></svg>
      <div ref={text} class="value-preview-text" tabindex="0">{value()}</div>
    </div>
  </div>;
}
