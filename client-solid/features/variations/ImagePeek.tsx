import { createSignal, createEffect, onCleanup, untrack, For, Show } from "solid-js";
import { useImageDisplay, imageRequestUrl } from "../../lib/img-measure.js";
import { SingleLineText } from "../../components/SingleLineText.js";
import { peekBox, containBox, flipTransform, PEEK_MS } from "./image-peek.js";

// One top-layer, pointer-transparent view of the peek owner's state. Each
// picture keeps its native element from load to retirement: the shown frame
// stays until a newer one has decoded (thumbnail first, then full image).
export function ImagePeek(props) {
  let layer, backdrop, frameElement, seq = 0, origin = null, lastTarget = null, motion = [], closing = false;
  const [frames, setFrames] = createSignal([]);
  const [opened, setOpened] = createSignal(false);
  const [presented, setPresented] = createSignal(false), [name, setName] = createSignal("image");
  const [viewport, setViewport] = createSignal({ width: innerWidth, height: innerHeight });
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const shown = () => frames().findLast(frame => frame.natural()) ?? null;
  const failed = () => !shown() && frames().length > 0 && frames().every(frame => frame.failed());
  const box = () => { const frame = shown(); return frame ? peekBox(frame.natural(), viewport()) : null; };
  const stop = () => { for (const animation of motion) animation.cancel(); motion = []; };
  const resize = () => setViewport({ width: innerWidth, height: innerHeight });
  const visible = () => layer.matches(":popover-open");
  const frame = (src, next, descriptor) => {
    const [natural, setNatural] = createSignal(null), [failure, setFailure] = createSignal(false);
    return { id: ++seq, src, next, local: !!descriptor.local, name: descriptor.name ?? "image", natural, setNatural, failed: failure, setFailure };
  };
  const want = descriptor => {
    setName(descriptor?.name ?? "image");
    const latest = frames().at(-1);
    if (!descriptor?.src || (latest && [descriptor.src, descriptor.full].includes(latest.src))) return;
    const full = descriptor.full && descriptor.full !== descriptor.src ? descriptor.full : null;
    setFrames(list => [...list, frame(descriptor.src, full, descriptor)]);
  };
  const finish = () => {
    stop(); closing = false; setOpened(false); setPresented(false); setFrames([]); origin = null;
    if (visible()) layer.hidePopover();
    removeEventListener("resize", resize);
  };
  const reveal = picture => {
    setOpened(true);
    const to = frameElement.getBoundingClientRect(), from = origin && containBox(picture, origin);
    if (reduced() || !from) return;
    motion = [frameElement.animate([{ transform: flipTransform(from, to) }, { transform: "none" }], { duration: PEEK_MS, easing: "ease-out" }),
      backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: PEEK_MS, easing: "ease-out" })];
  };
  const loaded = (record, image) => {
    if (!frames().includes(record)) return;
    record.setNatural({ width: image.naturalWidth, height: image.naturalHeight });
    // Older frames were only held to avoid a flash; a newer request stays.
    setFrames(list => list.slice(list.indexOf(record)));
    if (record.next && frames().at(-1) === record) setFrames(list => [...list, frame(record.next, null, record)]);
    if (!opened()) reveal(record.natural());
  };
  const failedFrame = record => {
    if (!frames().includes(record)) return;
    record.setFailure(true);
    // A failed thumbnail must not strand a usable full-image request.
    if (record.next && frames().at(-1) === record) setFrames(list => [...list, frame(record.next, null, record)]);
    // A held picture outlives a failed replacement; alone, the failure shows.
    if (frames().some(other => other !== record && other.natural())) setFrames(list => list.filter(other => other !== record));
    else if (!opened()) setOpened(true);
  };
  const show = (target, descriptor) => {
    // A new press during the closing motion starts a fresh opening from its tile.
    if (closing || !visible()) {
      finish(); origin = target.rect(); layer.showPopover();
      resize(); addEventListener("resize", resize);
    }
    setPresented(true); lastTarget = target; want(descriptor);
  };
  const hide = () => {
    if (!visible() || closing) return;
    const picture = shown()?.natural(), rect = lastTarget?.rect(), back = picture && rect && containBox(picture, rect);
    if (reduced() || !opened() || !back) { finish(); return; }
    // Reverse from wherever an unfinished opening currently is.
    const current = getComputedStyle(frameElement).transform, to = frameElement.getBoundingClientRect();
    const fade = getComputedStyle(backdrop).opacity;
    stop();
    const reverse = [frameElement.animate([{ transform: current === "none" ? "none" : current }, { transform: flipTransform(back, to) }], { duration: PEEK_MS, easing: "ease-out", fill: "forwards" }),
      backdrop.animate([{ opacity: fade }, { opacity: 0 }], { duration: PEEK_MS, easing: "ease-out", fill: "forwards" })];
    motion = reverse; closing = true;
    reverse[0].finished.then(() => { if (motion === reverse) finish(); }, () => {});
  };
  createEffect(() => {
    const state = props.state();
    const descriptor = state.open && state.target?.descriptor();
    untrack(() => state.open && state.target ? show(state.target, descriptor) : hide());
  });
  onCleanup(finish);
  return <div ref={layer} popover="manual" class="vz-peek" aria-hidden="true">
    <div ref={backdrop} class="vz-peek-backdrop" classList={{ "is-open": presented() }} />
    <div ref={frameElement} class="vz-peek-frame" classList={{ "is-empty": !shown(), "is-failed": failed() }}
      style={box() ? { width: `${box().width}px`, height: `${box().height}px` } : undefined}>
      <For each={frames()}>{record =>
        <PeekPicture record={record} shown={shown() === record} register={props.register}
          onLoad={image => loaded(record, image)} onError={() => failedFrame(record)} />}</For>
      <Show when={!shown() && !failed()}><div class="vz-peek-loading" role="status"><span class="vz-submit-spinner" aria-hidden="true" /><SingleLineText value={`Loading ${name()}`} /></div></Show>
      <Show when={failed()}><SingleLineText class="vz-peek-failure" role="status" value={`Couldn't load ${frames()[0]?.name}.`} /></Show>
    </div>
  </div>;
}

function PeekPicture(props) {
  let image;
  const src = imageRequestUrl(props.record.src, "foreground");
  const display = useImageDisplay(props.register, () => ({ id: props.record.local ? null : src, src, priority: "foreground" }), () => image);
  const settle = callback => { if (display.read().src == null) return; display.loaded(); callback(); };
  return <img ref={image} class="vz-peek-image" classList={{ "is-shown": props.shown }} src={display.read().src ?? undefined} alt=""
    decoding="async" draggable={false} onLoad={() => settle(() => props.onLoad(image))} onError={() => settle(props.onError)} />;
}
