import { onMount, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { iconSvg } from "/js/icons.mjs";
import { IconButton } from "./IconButton.js";

export const mediaTime = value => {
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

function MediaButton(props) {
  const button = () => <IconButton {...props} viewer={props.docked} />;
  return props.docked ? <span class="viewer-group">{button()}</span> : button();
}

export function MediaControls(props) {
  const soundOn = () => !props.muted;
  const bar = () => <MediaControlBoundary class="media-controls">
    <Show when={props.label}><span class="media-side">{props.label}</span></Show>
    <MediaButton docked={props.docked}
      variant="play media-toggle" title={props.paused ? "play" : "pause"}
      onAction={props.onToggle} icon={iconSvg(props.paused ? "player-play" : "player-pause", 20)} />
    <input class="media-seek" type="range" aria-label="seek" min="0" max={props.duration || 0} step="0.01"
      value={props.current} disabled={!props.duration} onInput={e => props.onSeek(Number(e.currentTarget.value))} />
    <span class="media-time">{mediaTime(props.current)} / {mediaTime(props.duration)}</span>
    <MediaButton docked={props.docked}
      variant="media-mute" title="Sound"
      active={soundOn()} onAction={props.onMute} icon={iconSvg(soundOn() ? "volume" : "volume-off", 16)} />
    <MediaButton docked={props.docked}
      variant="media-loop" title="loop" active={props.loop}
      onAction={props.onLoop} icon={iconSvg("repeat", 16)} />
    <Show when={props.onOpen}><IconButton variant="media-open" title="open full screen"
      onAction={props.onOpen} icon={iconSvg("full-screen", 16)} /></Show>
  </MediaControlBoundary>;
  // Placement and button presentation are independent. Feed feet and viewer
  // docks supply slots; native player state stays with MediaBox. A viewer
  // waits for its dock, while ordinary inline media keep their local bar.
  return <Show when={props.mount} fallback={props.docked ? undefined : bar()}>
    <Portal mount={props.mount}>{bar()}</Portal>
  </Show>;
}
