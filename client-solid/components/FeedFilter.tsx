// Encapsulated expansion/focus; the query still has its single store writer.
import { createSignal, createEffect, onCleanup } from "solid-js";
import { iconSvg } from "/js/icons.mjs";
import { IconButton } from "./IconButton.js";

export function FeedFilter(props) {
  const [expanded, setExpanded] = createSignal(false);
  let input, button;
  const collapse = () => { setExpanded(false); button?.focus(); };
  onCleanup(props.handles.own("feed.filter.close", collapse));
  onCleanup(props.handles.own("feed.filter.toggle", () => expanded() ? collapse() : setExpanded(true)));
  createEffect(() => {
    if (!expanded()) return;
    const disposeLayer = props.pushLayer({ id: "feed-filter", command: "feed.filter.close", decline: () => props.canEscape && !props.canEscape() });
    input?.focus();
    onCleanup(disposeLayer);
  });
  return (
    <div class="feed-filter">
      <input id="filter" ref={input} hidden={!expanded()} type="search"
        aria-label="Filter filenames" placeholder="filter filenames…" spellcheck={false}
        value={props.value} onInput={(e) => props.onInput(e.target.value)} />
      <IconButton id="filterBtn" chrome variant="filter" buttonRef={(el) => button = el}
        title={props.value ? `Filename filter: ${props.value}` : "Filter filenames"}
        active={!!props.value} expanded={expanded()} controls="filter" icon={iconSvg("filter", 16)}
        onAction={() => props.handles.invoke("feed.filter.toggle")} />
    </div>
  );
}
