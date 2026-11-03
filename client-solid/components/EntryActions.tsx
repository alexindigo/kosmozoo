// The single ordered action row for entries, selection, and measured card chrome.
// Target and judgment semantics are inputs; the Store remains the only writer.
import { For } from "solid-js";
import { iconSvg } from "/js/icons.mjs";
import { useAppStore } from "../store/app-store.js";
import { deleteCopy } from "../lib/delete-copy.js";
import { IconButton } from "./IconButton.js";

const actions = [
  { icon: "thumb-down", variant: "down", title: subject => `thumbs down ${subject} — hides when down-vote hides is enabled`, command: "judgment.apply", field: "vote", value: "down" },
  { icon: "thumb-up", variant: "up", title: subject => `thumbs up ${subject}`, command: "judgment.apply", field: "vote", value: "up" },
  { icon: "star", variant: "favorite", title: subject => `favorite ${subject} — interesting in itself, not project fitness`, command: "judgment.apply", field: "favorite" },
  { icon: "bookmark", variant: "bookmark", title: subject => `bookmark — return to ${subject} later`, command: "judgment.apply", field: "bookmark" },
  { icon: "download", variant: "download", title: subject => `download ${subject}`, command: "image.download" },
  { variant: "delete", command: "image.delete.request", deletion: true },
];

// These are semantic payload constructors, never reads/toggles of judgment state.
const intents = {
  toggle: action => ({ type: "toggle", field: action.field, ...(action.value ? { value: action.value } : {}) }),
  set: action => ({ type: "set", patch: { [action.field]: action.value ?? true } }),
};

export function EntryActions(props) {
  const store = useAppStore();
  const subject = () => props.target.target === "selected" ? "all selected" : `this ${props.word ?? "image"}`;
  const catalogue = () => [
    ...store.state.featureEntryActions(props.target),
    ...actions.filter(action => !action.deletion || props.deleteCapability).map(action => {
      const copy = action.deletion ? deleteCopy(props.deleteCapability) : null;
      return {
        variant: action.variant,
        icon: iconSvg(copy?.icon ?? action.icon, action.deletion ? 16 : 14),
        title: copy ? (props.target.target === "selected" ? copy.bulkTitle : copy.cardTitle) : action.title(subject()),
        command: action.command,
        args: { ...props.target, ...(action.field ? { intent: intents[props.judgmentType](action) } : {}) },
      };
    }),
  ];
  return <For each={catalogue()}>{action =>
    <IconButton icon={action.icon} variant={action.variant} title={action.title}
      active={props.active?.[action.variant]}
      onAction={() => store.handles.invoke(action.command, action.args)} />
  }</For>;
}
