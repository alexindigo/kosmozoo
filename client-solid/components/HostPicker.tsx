// client-solid/components/HostPicker.tsx — the host picker, declarative.
//
// Collapsed = status dot + current host name + ▾. Open = one row per host +
// an add row. Data/actions come from the global store; this declares the DOM
// and forwards intents.

import { createSignal } from "solid-js";
import { For } from "solid-js";
import { iconSvg } from "/js/icons.mjs";
import { useAppStore } from "../store/app-store.js";
import { useClickOutside } from "../lib/click-outside.js";
import { IconButton } from "./IconButton.js";
import { FeedbackLink } from "./FeedbackLink.js";

export function HostPicker() {
  const store = useAppStore();
  let rootRef;
  const [name, setName] = createSignal("");
  const [addr, setAddr] = createSignal("");

  // click outside closes the dropdown — the shared primitive; the root
  // contains the button, so it needs no stopPropagation shield
  useClickOutside(() => rootRef, () => {
    if (store.state.hostMenuOpen()) store.handles.invoke("source.menu.close");
  });

  const submitAdd = async () => {
    const r = await store.handles.invoke("source.add", { name: name(), address: addr() });
    if (r.ok) {
      setName("");
      setAddr("");
    }
  };

  return (
    <div id="hostPicker" ref={rootRef}>
      <button
        id="hostBtn"
        title="choose host"
        onClick={() => store.handles.invoke("source.menu.toggle")}
      >
        <span class={"hdot" + (store.state.hosts[store.state.host()]?.online ? "" : " off")} />
        <span>{store.state.host() ?? "no hosts"}</span>
        <span class="chev">▾</span>
      </button>
      <div id="hostDrop" hidden={!store.state.hostMenuOpen()}>
        <div id="hostList">
          <For each={Object.keys(store.state.hosts)}>
            {(n) => {
              const h = () => store.state.hosts[n];
              return (
                <div
                  class={"hostpick" + (n === store.state.host() ? " current" : "") + (h().online ? "" : " off")}
                  data-source={n}
                  title={`${n} — ${h().address}` + (h().online ? "" : " (offline)")}
                  onClick={() => store.handles.invoke("source.select", { id: n })}
                >
                  <span class={"hdot" + (h().online ? "" : " off")} />
                  <span class="hname">{n}</span>
                  <span class="haddr">{h().address + (h().online ? "" : " · offline")}</span>
                  <IconButton chrome variant="pin" active={h().pinned} disabled={!!store.state.sourceSaving[n]}
                    title={`${h().pinned ? "Unpin" : "Pin"} source ${n}`} icon={iconSvg("pin", 14)}
                    onAction={() => store.handles.invoke("source.attributes", { id: n, toggle: "pinned" })} />
                  <IconButton chrome variant="auto-refresh" active={h().autoRefresh}
                    disabled={h().kind === "folder" || !!store.state.sourceSaving[n]}
                    title={h().kind === "folder" ? "No generation jobs for folder sources" : `Auto-refresh ${n} when a job finishes`}
                    icon={iconSvg("refresh", 14)} onAction={() => store.handles.invoke("source.attributes", { id: n, toggle: "autoRefresh" })} />
                  <FeedbackLink source={n}
                    class="dl"
                    title={`download ${n}'s judgments (feedback.json, generated on demand)`}
                    icon={iconSvg("download", 12)}
                  />
                  <button
                    class="rm"
                    title={`remove ${n}`}
                    onClick={(e) => { e.stopPropagation(); store.handles.invoke("source.remove", { id: n }); }}
                    innerHTML={iconSvg("trash", 12)}
                  />
                </div>
              );
            }}
          </For>
        </div>
        <div class="haddrow">
          <input
            type="text" id="hostName" placeholder="name" spellcheck={false}
            value={name()} onInput={(e) => setName(e.target.value)}
          />
          <input
            type="text" id="hostAddr" placeholder="host:port or folder:/path" spellcheck={false}
            value={addr()} onInput={(e) => setAddr(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitAdd(); }}
          />
          <button id="hostAdd" onClick={submitAdd}>add</button>
        </div>
      </div>
    </div>
  );
}
