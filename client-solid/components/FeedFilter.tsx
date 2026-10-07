// Encapsulated expansion/focus; the query still has its single store writer.
import { createSignal, createEffect, onCleanup } from "solid-js";
import { iconSvg } from "/js/icons.mjs";
import { IconButton } from "./IconButton.js";

export function FeedFilter(props) {
  const [expanded, setExpanded] = createSignal(false);
  let input, button;
  const collapse = () => { setExpanded(false); button?.focus(); };
  const escape = () => {
    if (props.canEscape && !props.canEscape()) return false;
    collapse();
  };
  createEffect(() => {
    if (!expanded()) return;
    props.pushLayer({ id: "feed-filter", onEscape: escape });
    input?.focus();
    onCleanup(() => props.popLayer("feed-filter"));
  });
  return (
    <div class="feed-filter">
      <input id="filter" ref={input} hidden={!expanded()} type="search"
        aria-label="Filter filenames" placeholder="filter filenames…" spellcheck={false}
        value={props.value} onInput={(e) => props.onInput(e.target.value)} />
      <IconButton id="filterBtn" chrome variant="filter" buttonRef={(el) => button = el}
        title={props.value ? `Filename filter: ${props.value}` : "Filter filenames"}
        active={!!props.value} expanded={expanded()} controls="filter" icon={iconSvg("filter", 16)}
        onAction={() => expanded() ? collapse() : setExpanded(true)} />
    </div>
  );
}
