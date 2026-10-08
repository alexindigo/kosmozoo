// Real resource attributes retain native modified/auxiliary navigation.
import { useAppStore } from "../store/app-store.js";
export function FeedbackLink(props) {
  const store = useAppStore();
  return <a class={props.class} title={props.title}
    href={`/api/collections/${encodeURIComponent(props.source)}/feedback.json`}
    download={`kosmozoo_${props.source}_feedback.json`}
    onClick={(event) => {
      event.stopPropagation();
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      store.handles.invoke("collection.feedback.download", { source: props.source });
    }} innerHTML={props.icon}>{props.children}</a>;
}
