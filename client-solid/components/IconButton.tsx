// client-solid/components/IconButton.tsx — ONE icon button, fixed everywhere.
//
// Carries the votebtn class contract verbatim: "votebtn <variant>" plus ".on"
// when active; the variant class owns the accent via CSS (--btn-c), so no
// inline color. The click stops propagation and executes onAction.

export function IconButton(props) {
  return (
    <button
      class={"votebtn " + props.variant + (props.active ? " on" : "")}
      title={props.title}
      onClick={(e) => { e.stopPropagation(); props.onAction(e); }}
      innerHTML={props.icon}
    />
  );
}
