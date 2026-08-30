// client-solid/components/MetaBody.tsx — the full-metadata body, declarative.
//
// Shared by the details body and (phase 6) the ⓘ overlay. Fields group into
// collapsible per-node sections named by the actual node type (class_type —
// stable, never a per-instance rename; collapse state persists in
// localStorage). Prompt groups (CLIPTextEncode) sink to the bottom.
// `compareMeta` (the previous image's meta) marks field VALUES that differ
// from it with .pdiff. `host` enables inline node-referenced images;
// `skipImages` leaves those to a caller-drawn column instead.

import { createSignal, For, Show } from "solid-js";
import { useAppStore } from "../store/app-store.js";
import { fullFieldRows, valueDiffer, nodeImages, NODE_IMG_EXT } from "../store/fields.js";

const LS_INFOGROUPS = "kosmozoo.infoGroups.v1";

function infoGroupState() {
  try { return JSON.parse(localStorage.getItem(LS_INFOGROUPS)) ?? {}; }
  catch { return {}; }
}

function persistInfoGroup(group, collapsed) {
  const s = infoGroupState();
  if (collapsed) s[group] = true;
  else delete s[group];
  try { localStorage.setItem(LS_INFOGROUPS, JSON.stringify(s)); } catch { /* ignore */ }
}

export function MetaBody(props) {
  const store = useAppStore();
  const ctx = () => ({ list: store.state.fieldsList(), cfg: store.state.fieldsCfg() });
  const rows = () => props.meta ? fullFieldRows(props.meta, ctx()) : [];
  const differs = () => valueDiffer(props.compareMeta, ctx());

  // group rows by their node type (the part before " — "), first-appearance
  // order; prompt groups sink to the bottom of the section list
  const groups = () => {
    const m = new Map();
    for (const [label, v, long] of rows()) {
      const i = label.indexOf(" — ");
      const key = i > 0 ? label.slice(0, i) : label;
      if (!m.has(key)) m.set(key, []);
      m.get(key).push([label.slice(i + 3), v, long]);
    }
    return [...m].sort((a, b) =>
      +/clip\s*text\s*encode/i.test(a[0]) - +/clip\s*text\s*encode/i.test(b[0]));
  };

  const [collapsed, setCollapsed] = createSignal(infoGroupState());
  const toggleGroup = (group) => {
    const now = !collapsed()[group];
    setCollapsed({ ...collapsed(), [group]: now || undefined });
    persistInfoGroup(group, now);
  };

  return (
    <div>
      <Show
        when={rows().length > 0}
        fallback={
          <div class="info-none">
            {props.meta?.nodes?.length
              ? "This image has no scalar node fields."
              : "This image has no embedded parameters."}
          </div>
        }
      >
        <For each={groups()}>
          {([group, grows]) => (
            <InfoGroup
              group={group}
              grows={grows}
              host={props.host}
              differs={differs}
              isCollapsed={() => !!collapsed()[group]}
              onToggle={() => toggleGroup(group)}
            />
          )}
        </For>
        <Show when={props.host && !props.skipImages}>
          <For each={nodeImages(props.meta, props.host)}>
            {(im) => (
              <div class="infoimg">
                <div class="plabel">{im.label}</div>
                <img src={im.src} loading="lazy" alt={im.file} />
              </div>
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
}

function InfoGroup(props) {
  // short values first; text prompts (long values) render below them
  const shortRows = () => props.grows.filter(([, , long]) => !long);
  const longRows = () => props.grows.filter(([, , long]) => long);

  return (
    <div class={"infogroup" + (props.isCollapsed() ? " collapsed" : "")} data-group={props.group}>
      <button
        class="infogroup-head"
        title={props.isCollapsed() ? "expand" : "collapse"}
        onClick={props.onToggle}
      >
        {props.group}
        <span class="chev">▾</span>
      </button>
      <div class="infogroup-body">
        <div class="props">
          <For each={shortRows()}>
            {([input, v]) => {
              const changed = () => props.differs()(`${props.group} — ${input}`, v);
              return (
                <div>
                  <span class="plabel">{input}: </span>
                  <Show
                    when={props.host && NODE_IMG_EXT.test(String(v))}
                    fallback={
                      <Show when={changed()} fallback={v}>
                        <span class="pdiff">{v}</span>
                      </Show>
                    }
                  >
                    <span class={"imgref" + (changed() ? " pdiff" : "")} data-file={v}>{v}</span>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
        <For each={longRows()}>
          {([input, v]) => (
            <div class="infosec">
              <div class="plabel">{input}</div>
              <div class={"infotext" + (props.differs()(`${props.group} — ${input}`, v) ? " pdiff" : "")}>{v}</div>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
