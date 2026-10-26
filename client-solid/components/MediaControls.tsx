import { onMount, onCleanup } from "solid-js";
import { iconSvg } from "/js/icons.mjs";

const time = value => {
  const n = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
};

// Native pointer boundary: a stage's pan binding must never capture controls.
export function MediaControlBoundary(props) {
  let el;
  onMount(() => {
    const stop = e => e.stopPropagation();
    el.addEventListener("pointerdown", stop);
    onCleanup(() => el.removeEventListener("pointerdown", stop));
  });
  return <div ref={el} class={props.class} onClick={e => e.stopPropagation()}>{props.children}</div>;
}

export function MediaControls(props) {
  return <MediaControlBoundary class="media-controls">
    <button type="button" class="media-toggle" title={props.paused ? "play" : "pause"}
      aria-label={props.paused ? "play" : "pause"} onClick={props.onToggle} innerHTML={iconSvg(props.paused ? "player-play" : "player-pause", 16)} />
    <input class="media-seek" type="range" aria-label="seek" min="0" max={props.duration || 0} step="0.01"
      value={props.current} disabled={!props.duration} onInput={e => props.onSeek(Number(e.currentTarget.value))} />
    <span class="media-time">{time(props.current)} / {time(props.duration)}</span>
    <button type="button" class="media-mute" title={props.muted ? "unmute" : "mute"}
      aria-label={props.muted ? "unmute" : "mute"} aria-pressed={props.muted} onClick={props.onMute} innerHTML={iconSvg(props.muted ? "volume-off" : "volume", 16)} />
    <button type="button" class="media-loop" title="loop" aria-label="loop" aria-pressed={props.loop}
      onClick={props.onLoop} innerHTML={iconSvg("repeat", 16)} />
    <button type="button" class="media-open" title={`open ${props.kind === "audio" ? "audio file" : props.kind} in viewer`} aria-label={`open ${props.kind === "audio" ? "audio file" : props.kind} in viewer`}
      onClick={props.onOpen} innerHTML={iconSvg("open-viewer", 16)} />
  </MediaControlBoundary>;
}
