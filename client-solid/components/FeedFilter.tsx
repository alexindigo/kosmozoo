// Popup presentation only; the Store owns all URL-backed filter conditions.
import { createSignal, createEffect, onCleanup, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { iconSvg } from "/js/icons.mjs";
import { IconButton } from "./IconButton.js";
import { TextField } from "./TextField.js";
import { ModeSwitch } from "./ModeSwitch.js";
import { Select } from "./Select.js";
import { popoverPlacement } from "../lib/popover-placement.js";
import { useClickOutside } from "../lib/click-outside.js";

const statuses = [ ['down', 'thumb-down', 'Thumbs down'], ['up', 'thumb-up', 'Thumbs up'],
  ['favorite', 'star', 'Starred'], ['bookmark', 'bookmark', 'Bookmarked'] ];
export function FeedFilter(props) {
  const [expanded, setExpanded] = createSignal(false);
  const [placement, setPlacement] = createSignal(null);
  const [search, setSearch] = createSignal("");
  let input, button, menu, wrap;
  const edit = (field, value) => props.onEdit(field, value);
  const collapse = () => { setExpanded(false); button?.focus(); };
  useClickOutside(() => ({ contains: target => wrap?.contains(target) || menu?.contains(target) }), () => {
    if (expanded()) setExpanded(false);
  });
  onCleanup(props.handles.own("feed.filter.close", collapse));
  onCleanup(props.handles.own("feed.filter.toggle", () => expanded() ? collapse() : setExpanded(true)));
  createEffect(() => {
    if (!expanded()) return;
    const disposeLayer = props.pushLayer({ id: "feed-filter", command: "feed.filter.close", decline: () => props.canEscape && !props.canEscape() });
    let frame;
    const place = () => {
      setPlacement(popoverPlacement(button.getBoundingClientRect(), { width: innerWidth, height: innerHeight },
        { width: 360, height: 580, minHeight: 180 }));
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); };
    place();
    const focusFrame = requestAnimationFrame(() => input?.focus());
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    onCleanup(() => { disposeLayer(); cancelAnimationFrame(frame); cancelAnimationFrame(focusFrame); window.removeEventListener("resize", schedule); window.removeEventListener("scroll", schedule, true); });
  });
  const field = (key, label, placeholder = "contains…") => <TextField id={key === "filename" ? "filter" : `filter-${key}`}
    ref={el => { if (key === "filename") input = el; }} hidden={key === "filename" && !expanded()}
    type="search" aria-label={label} placeholder={placeholder} spellcheck={false}
    value={props.model[key]} onInput={e => edit(key, e.currentTarget.value)} />;
  const options = () => props.parameters.filter(name => name.toLowerCase().includes(search().toLowerCase()));
  createEffect(() => { expanded(); placement(); props.onExposureChange?.(); });
  const summary = () => props.conditions.length ? `${props.model.mode.toUpperCase()}: ${props.conditions.join("; ")}` : "Filter images";
  return <div class="feed-filter" ref={wrap}>
    <IconButton id="filterBtn" chrome variant="filter" buttonRef={el => button = el}
      title={summary()} active={props.conditions.length > 0} expanded={expanded()} controls="filterMenu"
      icon={iconSvg("filter", 16)} onAction={() => props.handles.invoke("feed.filter.toggle")} />
    <Portal><div id="filterMenu" class="feed-filter-menu" role="dialog" aria-label="Filter images" ref={element => {
      menu=element; const retire=props.registerOccluder?.(element); if(retire)onCleanup(retire);
    }}
      hidden={!expanded()} style={placement() ? { left: `${placement().left}px`, top: `${placement().top}px`,
        width: `${placement().width}px`, "max-height": `${placement().maxHeight}px` } : {}}>
      <Show when={expanded()}><div class="filter-row filter-combine"><span>Combine</span><ModeSwitch id="filterCombine" label="Combine conditions" value={props.model.mode}
        options={[{ value: "and", label: "AND" }, { value: "or", label: "OR" }]} onChange={value => edit("mode", value)} /></div></Show>
      <label class="filter-section"><span>Filename</span>{field("filename", "Filter filenames")}</label>
      <Show when={expanded()}>
      <label class="filter-section"><span>Directory</span>{field("directory", "Filter directory")}</label>
      <section class="filter-section" aria-label="Status"><span>Status</span><div class="filter-status">
        <For each={statuses}>{([key, icon, label]) => <IconButton variant={key} title={`${label}: ${props.model[key] ? "on" : "off"}`}
          active={props.model[key]} icon={iconSvg(icon, 14)} onAction={() => edit(key, String(!props.model[key]))} />}</For>
      </div></section>
      <section class="filter-section" aria-label="Feedback"><span>Feedback</span>
        <For each={["negative", "positive"]}>{sign => <div class="filter-feedback">
          <label for={`filter-${sign}-mode`}>{sign === "negative" ? "Negative" : "Positive"}</label>
          <Select id={`filter-${sign}-mode`} aria-label={`${sign} feedback`} value={props.model[sign + "Mode"]} onChange={e => edit(sign + "Mode", e.currentTarget.value)}>
            <option value="any">Any</option><option value="nonempty">Non-empty</option><option value="contains">Contains</option>
          </Select>
          <Show when={props.model[sign + "Mode"] === "contains"}>{field(sign, `${sign} feedback contains`)}</Show>
        </div>}</For>
      </section>
      <section class="filter-section" aria-label="Parameter"><span>Parameter</span>
        <TextField type="search" aria-label="Search parameter names" placeholder="search parameters…" value={search()} onInput={e => setSearch(e.currentTarget.value)} />
        <Select aria-label="Parameter name" value={props.model.parameter} onChange={e => edit("parameter", e.currentTarget.value)}>
          <option value="">Choose parameter…</option>
          <Show when={props.model.parameter && !options().includes(props.model.parameter)}><option value={props.model.parameter}>{props.model.parameter}</option></Show>
          <For each={options()}>{name => <option value={name}>{name}</option>}</For>
        </Select>
        <div class="filter-parameter-value"><Show when={props.model.parameter}><Select aria-label="Parameter comparison" value={props.model.parameterMode} onChange={e => edit("parameterMode", e.currentTarget.value)}>
          <option value="present">Present</option><option value="equals">Equals</option><option value="contains">Contains</option>
        </Select><Show when={props.model.parameterMode !== "present"}>{field("parameterValue", "Parameter value", "value…")}</Show></Show></div>
      </section>
      <footer class="filter-footer"><Show when={props.conditions.length}><button id="clearFilters" type="button" class="btn" onClick={() => props.onClear()}>Clear filters</button></Show>
        <span id="filterMatchCount">{props.count} of {props.total}</span>
        <Show when={props.loading}><span class="filter-loading">{props.loading} still loading</span></Show>
      </footer>
      </Show>
    </div></Portal>
  </div>;
}
