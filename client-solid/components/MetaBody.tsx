// client-solid/components/MetaBody.tsx — the full-metadata body, declarative.
//
// Shared by the details body and the ⓘ overlay. Fields group into
// collapsible per-node sections named by the actual node type (class_type —
// stable, never a per-instance rename; collapse state persists in the
// store's uiSt). Prompt groups (CLIPTextEncode) sink to the bottom.
// `compareMeta` (the previous image's meta) marks field VALUES that differ
// from it with .pdiff. `host` enables inline node-referenced images;
// `skipImages` leaves those to a caller-drawn column instead. Image-filename
// spans (.imgref) report clicks through the optional onImageRef(key)
// callback — the component never leaks its internals to a parent.

import { createMemo, createUniqueId, For, Show } from "solid-js";
import { useAppStore } from "../store/app-store.js";
import { fullFieldRows, valueDiffer, nodeImages, imageReference } from "../store/fields.js";
import { useMeasuredSrc, useImageDisplay } from "../lib/img-measure.js";
import { iconSvg } from "/js/icons.mjs";
import { IconButton } from "./IconButton.js";

export function MetaBody(props) {
  const store = useAppStore();
  const ctx = () => ({ list: store.state.fieldsList() });
  // derived data is memoized — these recompute per meta change, not per render
  const rows = createMemo(() => props.meta ? fullFieldRows(props.meta, ctx()) : []);
  const differs = createMemo(() => valueDiffer(props.compareMeta, ctx()));

  // group rows by their node type (the part before " — "), first-appearance
  // order; prompt groups sink to the bottom of the section list
  const groups = createMemo(() => {
    const m = new Map();
    for (const [label, v, long, intent, occurrence] of rows()) {
      const i = label.indexOf(" — ");
      const key = i > 0 ? label.slice(0, i) : label;
      if (!m.has(key)) m.set(key, []);
      m.get(key).push([label.slice(i + 3), v, long, intent, occurrence]);
    }
    return m;
  });
  // Registry publication can re-project equal rows. Key owners by semantic
  // identity, not fresh tuple arrays, so focus and row controls survive it.
  const groupNames = () => [...groups().keys()].sort((a, b) =>
    +/clip\s*text\s*encode/i.test(a) - +/clip\s*text\s*encode/i.test(b));

  // collapse state lives in the store (persisted under the same
  // kosmozoo.infoGroups.v1 key as before)
  const toggleGroup = (group) => store.handles.invoke("metadata.group.toggle", { group });

  return (
    <div>
      <Show
        when={rows().length > 0}
        fallback={
          <div class="info-none">
            {props.meta?.nodes?.length
              ? "No scalar generation parameters"
              : "No embedded generation parameters"}
          </div>
        }
      >
        <For each={groupNames()}>
          {(group) => (
            <InfoGroup
              group={group}
              grows={groups().get(group)}
              host={props.host}
              differs={differs}
              isCollapsed={() => !!store.ui.infoGroups[group]}
              onToggle={() => toggleGroup(group)}
              onImageRef={props.onImageRef}
              onFilter={props.onFilter}
            />
          )}
        </For>
        <Show when={props.host && !props.skipImages}>
          <For each={nodeImages(props.meta, props.host)}>
            {(im) => {
              // the feed's rule here too: the img mounts only at its
              // measured aspect — no grow-on-load morph (a failed measure
              // still renders so the broken-bytes state stays visible)
              const measured = useMeasuredSrc(store.actions.images.inline, () => ({ src: im.src, identity: props.identity ?? props.meta, foregroundId: props.entryId }));
              const s = () => measured().size;
              let element;
              const display = useImageDisplay(store.actions.images.display, () => ({
                id: measured().id, src: measured().src, foregroundId: measured().foregroundId,
              }), () => element);
              return (
                <div class="infoimg">
                  <div class="plabel">{im.label}</div>
                  <Show when={s() !== "pending"}>
                    <img
                      ref={element}
                      src={display.read().src ?? undefined}
                      fetchpriority={display.read().priority === "background" ? "low" : "auto"}
                      onLoad={display.loaded}
                      onError={display.loaded}
                      decoding="async"
                      alt={im.file}
                      style={s() !== "failed" ? { "aspect-ratio": `${s().w} / ${s().h}`, width: "100%" } : undefined}
                    />
                  </Show>
                </div>
              );
            }}
          </For>
        </Show>
      </Show>
    </div>
  );
}

function InfoGroup(props) {
  const id = `metadata-group-${createUniqueId()}`;
  const grows = () => props.grows ?? [];
  const rowsByKey = createMemo(() => new Map(grows().map(row => [row[4], row])));
  // short values first; text prompts (long values) render below them
  const shortRows = () => grows().filter(([, , long]) => !long).map(row => row[4]);
  const longRows = () => grows().filter(([, , long]) => long).map(row => row[4]);

  return (
    <div class={"infogroup" + (props.isCollapsed() ? " collapsed" : "")}>
      <button
        class="infogroup-head"
        title={props.isCollapsed() ? "expand" : "collapse"}
        aria-expanded={!props.isCollapsed()} aria-controls={id}
        onClick={props.onToggle}
      >
        {props.group}
        <span class="chev">▾</span>
      </button>
      <div class="infogroup-body" id={id}>
        <div class="props">
          <For each={shortRows()}>
            {(key) => {
              const row = () => rowsByKey().get(key);
              const input = () => row()?.[0] ?? "";
              const value = () => row()?.[1] ?? "";
              const changed = () => props.differs()(`${props.group} — ${input()}`, value());
              return (
                <InfoRow intent={row()?.[3]} onFilter={props.onFilter}>
                  <span class="info-filter-content">
                    <span class="plabel">{input()}: </span>
                    <Show
                      when={props.host && imageReference(String(value()))}
                      fallback={
                        <Show when={changed()} fallback={value()}>
                          <span class="pdiff">{value()}</span>
                        </Show>
                      }
                    >
                      <span
                        class={"imgref" + (changed() ? " pdiff" : "")}
                        onClick={() => props.onImageRef?.(imageReference(String(value())).key)}
                      >{value()}</span>
                    </Show>
                  </span>
                </InfoRow>
              );
            }}
          </For>
        </div>
        <For each={longRows()}>
          {(key) => {
            const row = () => rowsByKey().get(key);
            return <InfoRow long heading={row()?.[0]} intent={row()?.[3]} onFilter={props.onFilter}>
              <div class={"infotext" + (props.differs()(`${props.group} — ${row()?.[0]}`, row()?.[1]) ? " pdiff" : "")}>{row()?.[1]}</div>
            </InfoRow>;
          }}
        </For>
      </div>
    </div>
  );
}

// The same intrinsic action slot serves short and long rows. Shared metadata
// surfaces opt in by supplying intent handling; this row knows no feed owner.
function InfoRow(props) {
  const filterable = () => !!props.intent && !!props.onFilter;
  return <div classList={{ infosec: !!props.long, "info-filter-row": filterable() }} data-parameter={filterable() ? props.intent.parameter : undefined}>
    <Show when={props.long} fallback={props.children}><div class="plabel">{props.heading}</div></Show>
    <Show when={filterable()}><span class="info-filter-action">
      <IconButton title={`Filter by ${props.intent?.parameter}`} icon={iconSvg("filter", 16)}
        onAction={() => props.onFilter(props.intent)} />
    </span></Show>
    <Show when={props.long}>{props.children}</Show>
  </div>;
}
