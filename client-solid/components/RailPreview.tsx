// Rail-private tooltip composition; native still rendering belongs to MediaBox,
// and request admission/retirement to the injected Store display port.
import { createEffect, createSignal, onMount, onCleanup, Show } from "solid-js";
import { mediaKind } from "/shared/backings/mime.mjs";
import { entryBytesUrl } from "/js/entry-url.mjs";
import { useImageDisplay } from "../lib/img-measure.js";
import { popoverPlacement } from "../lib/popover-placement.js";
import { mediaGeometry } from "../store/media-geometry.js";
import { MediaBox } from "./MediaBox.js";
import { SingleLineText } from "./SingleLineText.js";

export function RailPreview(props) {
  let panel, name, reason, frame = null, mounted = false;
  const [phase, setPhase] = createSignal(props.size?.failed ? "error" : "empty");
  const [placement, setPlacement] = createSignal(null);
  const kind = () => mediaKind(props.entry.filename) ?? "image";
  const visual = () => kind() === "image" || kind() === "video";
  const picture = () => visual() && phase() !== "error";
  const display = useImageDisplay(props.registerDisplay, () => ({
    id: visual() && !props.size?.failed ? props.entry.id : null,
    src: visual() && !props.size?.failed ? entryBytesUrl(props.entry.host, props.entry.filename) : null,
    identity: props.entry.hash, priority: "foreground",
  }));
  const update = () => {
    frame = null;
    if (!mounted) return;
    const cs = getComputedStyle(panel), px = key => parseFloat(cs[key]) || 0;
    const viewport = { width: innerWidth, height: innerHeight };
    const room = popoverPlacement(props.anchor, viewport,
      { width: parseFloat(cs.getPropertyValue("--fr-preview-width")), height: 0, side: "right" });
    if (!room) { setPlacement(null); return; }
    const width = room.width;
    const inlineChrome = px("paddingLeft") + px("paddingRight") + px("borderLeftWidth") + px("borderRightWidth");
    const blockChrome = px("paddingTop") + px("paddingBottom") + px("borderTopWidth") + px("borderBottomWidth");
    const extra = picture() ? mediaGeometry({ width: width - inlineChrome, size: props.size }).height
      : reason?.getBoundingClientRect().height ?? 0;
    const height = blockChrome + name.getBoundingClientRect().height + extra + (extra ? px("rowGap") : 0);
    setPlacement(popoverPlacement(props.anchor, viewport, { width, height, side: "right" }));
  };
  const schedule = () => { if (mounted && frame === null) frame = requestAnimationFrame(update); };
  createEffect(() => { phase(); props.size; schedule(); });
  createEffect(() => { placement(); props.onExposureChange?.(); });
  onMount(() => { mounted = true; panel.showPopover(); update(); });
  onCleanup(() => {
    mounted = false;
    if (frame !== null) cancelAnimationFrame(frame);
    if (panel.isConnected && panel.matches(":popover-open")) panel.hidePopover();
  });
  const onPhase = next => {
    if (next === "loaded" || next === "error") display.loaded();
    setPhase(next);
  };
  return <div ref={element => { panel=element; const retire=props.registerOccluder?.(element); if(retire)onCleanup(retire); }} popover="manual" role="tooltip" class="fr-preview"
    classList={{ "is-placed": !!placement() }} data-entry-id={props.entry.id}
    style={{ left: `${placement()?.left ?? 0}px`, top: `${placement()?.top ?? 0}px`,
      width: placement() ? `${placement().width}px` : undefined,
      height: placement() ? `${placement().height}px` : undefined }}>
    <Show when={picture()}>
      <div class="fr-preview-picture">
        <MediaBox workbench still kind={kind()} src={display.read().src} fetchPriority={display.read().priority}
          alt={props.entry.filename} size={props.size} onPhase={onPhase} />
        <Show when={phase() !== "loaded"}><span class="fr-preview-loading">Loading preview…</span></Show>
      </div>
    </Show>
    <SingleLineText ref={el => { name = el; }} class="fr-preview-name" value={props.entry.filename} />
    <Show when={phase() === "error"}><span ref={reason} class="fr-preview-reason" role="status">Preview unavailable</span></Show>
  </div>;
}
