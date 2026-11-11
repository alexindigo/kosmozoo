import { createSignal, createEffect, onCleanup, For, Show } from "solid-js";
import { useClickOutside } from "../../lib/click-outside.js";
import { popoverPlacement } from "../../lib/popover-placement.js";
import { Chevron } from "../../components/Select.js";
import { SingleLineText } from "../../components/SingleLineText.js";
import { HistoryList } from "./HistoryPanel.js";
import { focusMemory } from "./draft.js";

export function HistoryDropdown(props) {
  const [open, setOpen] = createSignal(false), [suspended, setSuspended] = createSignal(false), [placed, setPlaced] = createSignal(null);
  let root, trigger, panel;
  const close = () => { setOpen(false); trigger.focus(); };
  useClickOutside(() => root, () => { if (!suspended()) setOpen(false); });
  onCleanup(props.registerEditor({ suspend() { setSuspended(true); panel?.hidePopover(); }, resume() { setSuspended(false); } }));
  createEffect(() => { if (open()) onCleanup(props.history.interest()); });
  createEffect(() => { if (open() && !suspended()) onCleanup(props.registerPopup(close)); });
  createEffect(() => {
    if (!open() || suspended()) { panel?.hidePopover(); return; }
    let frame = null, alive = true;
    const update = () => {
      frame = null; if (!alive || !panel || !trigger.isConnected) return;
      const box = trigger.getBoundingClientRect(), geometry = popoverPlacement(box, { width: innerWidth, height: innerHeight },
        { width: Math.min(640, box.width), height: 320, minHeight: 80 });
      setPlaced(geometry); if (geometry && !panel.matches(":popover-open")) panel.showPopover();
    };
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(update); };
    const scroll = event => { if (event.target === window || event.target === document || event.target?.contains?.(trigger)) schedule(); };
    const observer = new ResizeObserver(schedule); observer.observe(trigger);
    window.addEventListener("resize", schedule); window.addEventListener("scroll", scroll, true); schedule();
    onCleanup(() => { alive = false; if (frame !== null) cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener("resize", schedule); window.removeEventListener("scroll", scroll, true); });
  });
  return <div class="vh-tools" ref={root}>
    <button ref={trigger} class="select-trigger control-size-md vh-trigger" aria-expanded={open()} aria-label="Recall a run" {...focusMemory(props.rememberFocus)}
      onClick={() => setOpen(!open())}><SingleLineText value={props.caption || "Recall a run..."} /><Chevron /></button>
    <Show when={open()}><div ref={panel} popover="manual" class="vh-menu" inert={suspended() || !placed()}
      style={{ left: `${placed()?.left ?? 0}px`, top: `${placed()?.top ?? 0}px`, width: `${placed()?.width ?? 320}px`, "max-height": `${placed()?.maxHeight ?? 320}px` }}>
      <div class="vh-menu-label">Apply saved changes to {props.bulk ? "these images" : "this image"}</div>
      <HistoryList compact history={props.history} state={props.state} thumbnail={props.thumbnail} registerThumbnail={props.registerThumbnail}
        registerPopup={props.registerPopup} registerEditor={props.registerEditor}
        onRecall={async id => { const result = await props.onRecall(id); if (result?.status === "applied") close(); }} />
    </div></Show>
    <Show when={props.warnings?.length}><div class="vh-warning" role="status"><strong>Applied compatible changes. Other settings were kept.</strong>
      <For each={props.warnings}>{warning => <span>{warning.label}: {warning.reason}</span>}</For>
    </div></Show>
  </div>;
}
