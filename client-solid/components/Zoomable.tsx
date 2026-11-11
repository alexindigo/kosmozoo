// Store adapter: preserve absolute dimensions through to the geometry owner,
// and register a mounted image's native load lifetime with the Store's one
// acquisition policy. Playable media keep MediaBox's own native lifetime.
import { useAppStore } from "../store/app-store.js";
import { mediaKind } from "/shared/backings/mime.mjs";
import { useImageDisplay } from "../lib/img-measure.js";
import { MediaBox } from "./MediaBox.js";

export function Zoomable(props) {
  const store = useAppStore();
  const kind = () => mediaKind(props.alt) ?? "image";
  const display = useImageDisplay(store.actions.images.display, () => ({
    src: props.src, id: kind() === "image" ? props.resourceId : null,
    foregroundId: props.foregroundId ?? props.resourceId, identity: props.identity,
  }));
  // MediaBox retires its native consumer when the admitted src becomes null.
  const phase = (p) => {
    if (p === "loaded" || p === "error") display.loaded();
    props.onPhase?.(p);
  };
  return <MediaBox src={display.read().src} fetchPriority={display.read().priority} kind={kind()} alt={props.alt} failed={props.failed}
    size={props.size} onOpen={props.onOpen} onErrorClick={props.onErrorClick} onPhase={phase}
    registerPlayer={store.actions.media.register} onPlaybackError={store.actions.media.report}
    focused={props.focused} controlsMount={props.controlsMount}
    registerExposure={props.registerExposure}
    zoom={{ key: props.zoomKey, getView: store.actions.views.get, setView: store.actions.views.set, onZoomChange: props.onZoomChange }} />;
}
