// client-solid/components/Modal.tsx — one modal shell for every overlay.
//
// Renders the fixed backdrop + centered panel. Clicking the backdrop (the
// overlay element itself, not its contents) closes it — structurally
// (target === currentTarget), never by id-string.
//
// Escape is NOT listened for here (G4): an open modal pushes itself onto the
// store's key-layer stack and the app's ONE key dispatcher hands Escape to
// the top layer — so exactly one modal closes per press, in open order, and
// a running key capture (a higher layer) outranks the panel underneath.
// `escapeLayer={false}` opts out (the keys panel's Esc-close is its own
// keymap binding). The caller supplies the panel's id/class and children;
// the close affordance is a child too, so each panel keeps its own layout.
//
// portal mode (`portal` prop): the Portal's container IS the overlay (the
// id/class/backdrop-handler land on it) — for modals whose DOM contract
// needs the overlay directly under <body> (the Solid Portal wraps content
// in its own div, which would otherwise sit between body and the overlay).
// Visibility in portal mode is the caller's conditional; `open` gates only
// the key layer.

import { createEffect, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { useAppStore } from "../store/app-store.js";

export function Modal(props) {
  const store = useAppStore();
  // open → on the layer stack; closed/unmounted → off it
  createEffect(() => {
    if (!props.open || props.escapeLayer === false) return;
    const id = props.overlayId ?? props.class ?? "modal";
    store.actions.keys.pushLayer({ id, onEscape: () => props.onClose() });
    onCleanup(() => store.actions.keys.popLayer(id));
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
