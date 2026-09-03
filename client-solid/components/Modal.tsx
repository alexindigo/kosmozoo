// client-solid/components/Modal.tsx — one modal shell for every overlay.
//
// Renders the fixed backdrop + centered panel. Clicking the backdrop (the
// overlay element itself, not its contents) closes it — structurally
// (target === currentTarget), never by id-string. The caller supplies the
// panel's id and children; the close affordance is a child too, so each
// panel keeps its own layout.

export function Modal(props) {
  return (
    <div
      id={props.overlayId}
      hidden={!props.open}
      onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}
    >
      <div id={props.panelId}>{props.children}</div>
    </div>
  );
}
