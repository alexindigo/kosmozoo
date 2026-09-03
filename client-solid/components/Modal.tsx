// client-solid/components/Modal.tsx — one modal shell for every overlay.
//
// Renders the fixed backdrop + centered panel. Clicking the backdrop (the
// overlay element itself, not its contents) closes it — structurally
// (target === currentTarget), never by id-string. Esc closes too (capture
// phase: the modal outranks everything under it). The caller supplies the
// panel's id/class and children; the close affordance is a child too, so
// each panel keeps its own layout.
//
// portal mode (`portal` prop): the Portal's container IS the overlay (the
// id/class/backdrop-handler land on it) — for modals whose DOM contract
// needs the overlay directly under <body> (the Solid Portal wraps content
// in its own div, which would otherwise sit between body and the overlay).
// Visibility in portal mode is the caller's conditional; `open` gates only
// the Escape listener.

import { createEffect, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";

export function Modal(props) {
  // Esc closes (capture phase: the modal outranks everything under it)
  createEffect(() => {
    if (!props.open) return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => document.removeEventListener("keydown", onKey, true));
  });

  if (props.portal) {
    return (
      <Portal
        mount={document.body}
        ref={(el) => {
          if (props.overlayId) el.id = props.overlayId;
          if (props.class) el.className = props.class;
          el.addEventListener("click", (e) => {
            if (e.target === el) props.onClose();
          });
        }}
      >
        {props.children}
      </Portal>
    );
  }

  return (
    <div
      id={props.overlayId}
      class={props.class}
      hidden={!props.open}
      onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}
    >
      <div id={props.panelId} class={props.panelClass}>{props.children}</div>
    </div>
  );
}
