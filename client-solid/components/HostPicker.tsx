// client-solid/components/HostPicker.tsx — the host picker, declarative.
//
// Collapsed = status dot + current host name + ▾. Open = one row per host +
// an add row. Data/actions come from the global store; this declares the DOM
// and forwards intents. DOM contract identical to the preact HostPicker.

import { createSignal, onCleanup } from "solid-js";
import { For } from "solid-js/web";
import { iconSvg } from "/js/icons.mjs";
import { useAppStore } from "../store/app-store.js";

export function HostPicker() {
  const store = useAppStore();
  let rootRef;
  const [name, setName] = createSignal("");
  const [addr, setAddr] = createSignal("");

  // click outside closes the dropdown (the picker's own clicks stopPropagation)
  const onDocClick = (e) => {
    if (store.state.hostMenuOpen() && rootRef && !rootRef.contains(e.target)) {
      store.actions.hosts.closeMenu();
    }
  };
  document.addEventListener("click", onDocClick);
  onCleanup(() => document.removeEventListener("click", onDocClick));

  const submitAdd = async () => {
    const r = await store.actions.hosts.add(name(), addr());
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
        onClick={(e) => { e.stopPropagation(); store.actions.hosts.toggleMenu(); }}
      >
        <span id="hostDot" class={"hdot" + (store.state.hosts[store.state.host()]?.online ? "" : " off")} />
        <span id="hostBtnLabel">{store.state.host() ?? "no hosts"}</span>
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
                  title={`${n} — ${h().address}` + (h().online ? "" : " (offline)")}
                  onClick={() => store.actions.hosts.select(n)}
                >
                  <span class={"hdot" + (h().online ? "" : " off")} />
                  <span class="hname">{n}</span>
                  <span class="haddr">{h().address + (h().online ? "" : " · offline")}</span>
                  <a
                    class="dl"
                    title={`download ${n}'s judgments (feedback.json, generated on demand)`}
                    href={`/api/collections/${encodeURIComponent(n)}/feedback.json`}
                    download={`kosmozoo_${n}_feedback.json`}
                    onClick={(e) => e.stopPropagation()}
                    innerHTML={iconSvg("download", 12)}
                  />
                  <button
                    class="rm"
                    title={`remove ${n}`}
                    onClick={(e) => { e.stopPropagation(); store.actions.hosts.remove(n); }}
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
