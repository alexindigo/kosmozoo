// Store adapter for the shared media box; aspect remains pre-resolved DATA.
import { useAppStore } from "../store/app-store.js";
import { mediaKind } from "/shared/backings/mime.mjs";
import { MediaBox } from "./MediaBox.js";

function arStyle(ar) {
  if (!ar) return undefined;
  const parts = String(ar).split("/").map(s => parseFloat(s.trim()));
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  return `--ar-num:${Math.min(parts[0] / parts[1], 16 / 9)};--ar-den:1`;
}

export function Zoomable(props) {
  const store = useAppStore();
  return <MediaBox src={props.src} kind={mediaKind(props.alt) ?? "image"} alt={props.alt} failed={props.failed}
    boxStyle={arStyle(props.ar)} onOpen={props.onOpen} onErrorClick={props.onErrorClick} onPhase={props.onPhase}
    registerPlayer={store.actions.media.register} onPlaybackError={store.actions.media.report}
    focused={props.focused}
    zoom={{ key: props.zoomKey, getView: store.actions.views.get, setView: store.actions.views.set, onZoomChange: props.onZoomChange }} />;
}
