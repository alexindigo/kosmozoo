import { For } from "solid-js";

// Presentation only: never contributes entries or estimates to the virtualizer.
export function FeedGlimmer() {
  return <div class="feed-glimmer" role="status" aria-label="Loading source">
    <For each={[0, 1, 2]}>{() => <div class="feed-glimmer-card" aria-hidden="true">
      <div class="feed-glimmer-media" />
      <div class="feed-glimmer-foot">
        <div class="feed-glimmer-title" />
        <div class="feed-glimmer-actions"><For each={[0, 1, 2, 3]}>{() => <span />}</For></div>
      </div>
    </div>}</For>
  </div>;
}
