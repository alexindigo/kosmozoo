// client-solid/components/Modal.tsx — one modal shell for every overlay.
//
// ONE contract : the parent controls visibility with a <Show>; Modal
// renders the backdrop + panel (.modal-backdrop / .modal-panel) and always
// portals to document.body — the overlay is a page-level element by
// construction, never a child of the surface that opened it. Clicking the
// backdrop (the overlay element itself, not its contents) closes it —
// structurally (target === currentTarget), never by id-string.
//
// Escape is NOT listened for here : a mounted modal is a key layer and
// the app's ONE key dispatcher hands Escape to the top layer only — exactly
// one modal closes per press. `escapeLayer={false}` opts out (the keys
// panel's Esc-close is its own keymap binding). The caller supplies the
// overlay/panel ids and children; the close affordance is a child too, so
// each panel keeps its own layout.

import { onMount, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { useAppStore } from "../store/app-store.js";

export function Modal(props) {
  const store = useAppStore();
  // mounted == open (the parent's <Show> gates it): the key layer's
  // lifecycle is exactly the modal's lifecycle
  const layerId = props.overlayId ?? props.class ?? "modal";
  if (props.escapeLayer !== false) {
    onMount(() => store.actions.keys.pushLayer({ id: layerId, onEscape: () => props.onClose?.() }));
    onCleanup(() => store.actions.keys.popLayer(layerId));
  }

  return (
    <Portal mount={document.body}>
      <div
        id={props.overlayId}
        class={"modal-backdrop" + (props.class ? " " + props.class : "")}
        onClick={(e) => { if (e.target === e.currentTarget) props.onClose?.(); }}
      >
        <div id={props.panelId} class="modal-panel">
          {props.children}
        </div>
      </div>
    </Portal>
  );
}
