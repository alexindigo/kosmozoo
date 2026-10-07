// client-solid/components/IconButton.tsx — ONE icon button, fixed everywhere.
//
// Carries the votebtn class contract verbatim: "votebtn <variant>" plus ".on"
// when active; the variant class owns the accent via CSS (--btn-c), so no
// inline color. The click stops propagation and executes onAction.

export function IconButton(props) {
  return (
    <button
      type="button"
      id={props.id}
      disabled={props.disabled}
      ref={props.buttonRef}
      class={(props.chrome ? "chrome-icon " : "votebtn ") + props.variant + (props.active ? " on" : "")}
      title={props.title}
      aria-label={props.title}
      aria-pressed={props.active === undefined ? undefined : !!props.active}
      aria-expanded={props.expanded}
      aria-controls={props.controls}
      onClick={(e) => { e.stopPropagation(); props.onAction(e); }}
      innerHTML={props.icon}
    />
  );
}
