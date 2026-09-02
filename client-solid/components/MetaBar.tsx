// client-solid/components/MetaBar.tsx — the collapsed params line under a
// card: pixel size + on-disk size, an expand toggle, and the full
// fields-config panel inside (hidden until expanded). Contract: the parent
// passes explicit accessors — facts() (w/h/bytes), meta(), expanded() —
// read at the sites below; facts fill in as they arrive; rows derive from
// the store's registry + cfg.

import { Show, For } from "solid-js/web";
import { iconSvg } from "/js/icons.mjs";
import { useAppStore } from "../store/app-store.js";
import { materializeRows } from "../store/fields.js";

export function fmtBytes(n) {
  if (n == null) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function metaBarText(f) {
  const bits = [];
  if (f.w && f.h) bits.push(`${f.w}×${f.h}px`);
  const sz = fmtBytes(f.bytes);
  if (sz) bits.push(sz);
  return bits.length ? bits.join(" · ") : "no metadata yet";
}

export function MetaBar(props) {
  const store = useAppStore();

  const rows = () => props.meta()
    ? materializeRows(props.meta(), {
      gated: true,
      list: store.state.fieldsList(),
      cfg: store.state.fieldsCfg(),
    })
    : [];
  const shortRows = () => rows().filter(([, , long]) => !long);
  // long-text rows go to desc (truncated at 300 so the whole card stays
  // compact); the first one also lands in desc.title for hover
  const longRow = () => rows().find(([, , long]) => long) ?? null;
  const descText = () => {
    const l = longRow();
    if (!l) return "";
    const v = String(l[1]);
    return v.length > 300 ? v.slice(0, 300) + "…" : v;
  };
  const text = () => metaBarText(props.facts());

  return (
    <div class={"metabar" + (props.expanded() ? " open" : "")}>
      <span class="metabar-info" title={text()}>{text()}</span>
      <button
        class="metabar-toggle"
        title={props.expanded() ? "hide parameters" : "show parameters"}
        onClick={(e) => { e.stopPropagation(); props.onToggle(); }}
        innerHTML={iconSvg("chevron-down", 14)}
      />
      <div class="pair metabar-full" hidden={!props.expanded()}>
        <div class="props">
          <Show when={props.meta()} fallback={<span class="nometa">no metadata yet</span>}>
            <Show when={shortRows().length > 0} fallback="(no fields toggled on this image)">
              <For each={shortRows()}>
                {([label, v]) => <div><span class="plabel">{label}: </span>{v}</div>}
              </For>
            </Show>
          </Show>
        </div>
        <div class="desc" title={longRow() ? `${longRow()[0]} — ${longRow()[1]}` : ""}>
          {descText()}
        </div>
      </div>
    </div>
  );
}
