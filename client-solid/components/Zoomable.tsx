// Store adapter: preserve absolute dimensions through to the geometry owner.
import { useAppStore } from "../store/app-store.js";
import { mediaKind } from "/shared/backings/mime.mjs";
import { MediaBox } from "./MediaBox.js";

export function Zoomable(props) {
  const store = useAppStore();
  return <MediaBox src={props.src} kind={mediaKind(props.alt) ?? "image"} alt={props.alt} failed={props.failed}
    size={props.size} onOpen={props.onOpen} onErrorClick={props.onErrorClick} onPhase={props.onPhase}
    registerPlayer={store.actions.media.register} onPlaybackError={store.actions.media.report}
    focused={props.focused}
    zoom={{ key: props.zoomKey, getView: store.actions.views.get, setView: store.actions.views.set, onZoomChange: props.onZoomChange }} />;
}
