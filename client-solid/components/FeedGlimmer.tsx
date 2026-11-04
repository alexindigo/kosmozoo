import { For, createSignal, onMount, onCleanup } from "solid-js";

// Presentation only: never contributes entries or estimates to the virtualizer.
export function FeedGlimmer() {
  let viewport;
  const [count, setCount] = createSignal(1);
  onMount(() => {
    const card = viewport.firstElementChild;
    const measure = () => {
      const height = card.getBoundingClientRect().height;
      const gap = parseFloat(getComputedStyle(viewport).rowGap) || 0;
      if (height > 0) setCount(Math.ceil(viewport.clientHeight / (height + gap)) + 1);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(viewport); observer.observe(card); measure();
    onCleanup(() => observer.disconnect());
  });
  return <div ref={viewport} class="feed-glimmer" role="status" aria-label="Loading source">
    <For each={Array.from({ length: count() }, (_, i) => i)}>{() => <div class="feed-glimmer-card" aria-hidden="true">
      <div class="feed-glimmer-media" />
      <div class="feed-glimmer-foot">
        <div class="feed-glimmer-title" />
        <div class="feed-glimmer-actions"><For each={[0, 1, 2, 3]}>{() => <span />}</For></div>
      </div>
    </div>}</For>
  </div>;
}
