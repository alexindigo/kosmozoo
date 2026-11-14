import { For, Show, createSignal, createMemo, onCleanup, onMount } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { iconSvg } from "/js/icons.mjs";
import { SingleLineText } from "../../components/SingleLineText.js";
import { ValuePreview } from "../../components/ValuePreview.js";
import { IconButton } from "../../components/IconButton.js";
import { Thumbnail } from "./Thumbnail.js";

export const historyDate = created => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(new Date(created));
export function historyCount(entry) {
  const n = entry.summary.total ?? entry.summary.plannedCount;
  return n === null || n === undefined ? "Count unavailable" : `${n} ${String(n) === "1" ? "variation" : "variations"}`;
}
export function HistoryEntry(props) {
  const [expanded, setExpanded] = createSignal(null), [pending, setPending] = createSignal(null), [message, setMessage] = createSignal("");
  let alive = true; onCleanup(() => { alive = false; });
  const invoke = async action => { setMessage(""); try { await action(); } catch (error) { if (alive) setMessage(error.message); } };
  const inspect = async parameter => {
    if (expanded()?.id === parameter.id) { setExpanded(null); return; }
    setPending(parameter.id);
    await invoke(async () => {
      const record = await props.onInspect();
      if (!alive) return;
      const images = record.recipe.images[parameter.id].values.items.map(item => item.kind === "target"
        ? { ...item, runId: record.id, resourceId: "target-0", name: "Current image" } : item);
      setExpanded({ id: parameter.id, images });
    });
    if (alive) setPending(null);
  };
  return <article class="vh-entry" classList={{ "vh-compact": props.compact }} data-history-id={props.entry.id}>
    <div class="vh-content">
      <button type="button" class="vh-recall" onClick={() => invoke(props.onRecall)} title="Recall saved run">
        <span class="vh-head"><strong>{historyCount(props.entry)}</strong><time dateTime={new Date(props.entry.createdAt).toISOString()}>{historyDate(props.entry.createdAt)}</time></span>
        <Show when={props.targets}><SingleLineText class="vh-target" value={props.entry.summary.targets.join(", ")} /></Show>
      </button>
      <Show when={props.entry.outcome !== "submitted"}><span class="vh-outcome">{props.entry.outcome}{props.entry.summary.submitted ? ` (${props.entry.summary.submitted} queued)` : ""}</span></Show>
      <div class="vh-parameters"><For each={props.entry.summary.parameters.filter(p => p.kind !== "images")}>{parameter =>
        <span class="vh-parameter"><span class="vh-label" title={parameter.label}>{parameter.label.replace(/^.*\u00b7\s*/, "").split(".").at(-1)}:</span>
          <ValuePreview value={parameter.value} available registerPopup={props.registerPopup ?? (() => () => {})}
            registerEditor={props.registerEditor ?? (() => () => {})} /></span>
      }</For></div>
      <For each={props.entry.summary.parameters.filter(p => p.kind === "images")}>{parameter => <div class="vh-images">
        <SingleLineText class="vh-label" value={parameter.label} />
        <div class="vh-image-summary">
          <span class="vh-thumbs"><For each={(parameter.images ?? []).slice(0, props.compact ? 4 : 3)}>{image =>
            <Thumbnail src={props.thumbnail({ runId: props.entry.id, resourceId: image.kind === "target" ? "target-0" : image.resourceId })}
              name={image.name} lazy register={props.registerThumbnail} />
          }</For></span>
          <Show when={parameter.count > 1 && !props.compact} fallback={<SingleLineText class="vh-image-name" value={parameter.count === 1 ? parameter.images[0]?.name : `${parameter.count} images`} />}>
            <Show when={pending() !== parameter.id} fallback={<span role="status">Reading images...</span>}>
              <button class="vh-inspect" aria-expanded={expanded()?.id === parameter.id} onClick={() => inspect(parameter)}>
                <span>{parameter.count} images</span><span class="vh-chevron" innerHTML={iconSvg("chevron-down", 16)} /></button>
            </Show>
          </Show>
        </div>
        <Show when={expanded()?.id === parameter.id}><HistoryImages images={expanded().images} thumbnail={props.thumbnail} registerThumbnail={props.registerThumbnail} /></Show>
      </div>}</For>
      <Show when={message()}><p class="vh-error" role="status">{message()}</p></Show>
    </div>
    <Show when={props.onDelete}><Show when={!props.deleting} fallback={<span class="vh-delete-pending" role="status">Deleting...</span>}>
      <IconButton chrome size="sm" variant="plain vh-delete" icon={iconSvg("trash")} title="Delete saved run" onAction={() => invoke(props.onDelete)} />
    </Show></Show>
  </article>;
}

// Only the visible rows plus a small lookahead mount native consumers. The shared
// display owner retains transfer budgets; the contact sheet owns no fetch policy.
function HistoryImages(props) {
  let viewport;
  const [scroll, setScroll] = createSignal(null), [columns, setColumns] = createSignal(3);
  const rows = createMemo(() => Array.from({ length: Math.ceil(props.images.length / columns()) }, (_, i) => props.images.slice(i * columns(), (i + 1) * columns())));
  const virtual = createVirtualizer({ get count() { return rows().length; }, getScrollElement: scroll,
    estimateSize: () => 64, overscan: 1 });
  onMount(() => {
    const measure = () => setColumns(Math.max(1, Math.floor((viewport.clientWidth + 4) / 56)));
    measure(); setScroll(viewport);
    const observer = new ResizeObserver(measure); observer.observe(viewport); onCleanup(() => observer.disconnect());
  });
  return <div class="vh-contact" ref={viewport} tabindex="0" aria-label="Saved images in order">
    <div class="vh-contact-window" style={{ height: `${virtual.getTotalSize()}px` }}>
      <For each={virtual.getVirtualItems()}>{row => <div class="vh-contact-row" style={{ transform: `translateY(${row.start}px)`, "grid-template-columns": `repeat(${columns()}, minmax(0,1fr))` }}>
        <For each={rows()[row.index]}>{(item, offset) => <div class="vh-contact-tile" title={`${row.index * columns() + offset() + 1}: ${item.name}`} data-image-index={row.index * columns() + offset() + 1}>
          <Thumbnail src={props.thumbnail(item)} name={item.name} register={props.registerThumbnail} />
          <SingleLineText value={item.name} />
        </div>}</For>
      </div>}</For>
    </div>
  </div>;
}
