// client-solid/components/IconButton.tsx — ONE icon button, fixed everywhere.
//
// Owns the shared active/aria contract across card, chrome and viewer looks.
// Card variants own their accent via CSS (--btn-c); viewer states have one
// shared palette. The click stops propagation and executes onAction.

export function IconButton(props) {
  return (
    <button
      type="button"
      id={props.id}
      disabled={props.disabled}
      ref={props.buttonRef}
      class={(props.viewer ? "viewer-btn " : props.chrome ? "chrome-icon " : "votebtn ") + (props.variant ?? "") + (props.active ? " on" : "")}
      title={props.title}
      data-view={props["data-view"]}
      aria-label={props["aria-label"] ?? props.title}
      aria-pressed={props.active === undefined ? undefined : !!props.active}
      aria-expanded={props.expanded}
      aria-controls={props.controls}
      onClick={(e) => { e.stopPropagation(); props.onAction(e); }}
      innerHTML={props.icon}
    />
  );
}
