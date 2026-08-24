// client/app/components/HostPicker.mjs — the host picker, declared.
//
// Collapsed = status dot + current host name + ▾. Open = one row per host +
// an add row. The data/actions live in js/hostpicker.mjs; this declares the
// DOM from state and forwards intents.

import { h } from "../../vendor/preact/vendor.mjs";
import { useRef, useEffect } from "../../vendor/preact/vendor.mjs";
import { state, render } from "../../js/state.mjs";
import { selectHost, addHost, removeHost } from "../../js/hostpicker.mjs";
import { iconSvg } from "../../js/icons.mjs";
import { useVersion } from "../hooks/useVersion.mjs";

export function HostPicker() {
  useVersion();
  const rootRef = useRef(null);
  const nameRef = useRef(null);
  const addrRef = useRef(null);

  // click outside closes the dropdown (the picker's own clicks stopPropagation)
  useEffect(() => {
    const onDocClick = (e) => {
      if (state.hostMenuOpen && rootRef.current && !rootRef.current.contains(e.target)) {
        state.hostMenuOpen = false;
        render();
      }
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, []);

  const cur = state.hosts[state.host];

  const submitAdd = async () => {
    const r = await addHost(nameRef.current?.value, addrRef.current?.value);
    if (r.ok) {
      if (nameRef.current) nameRef.current.value = "";
      if (addrRef.current) addrRef.current.value = "";
    }
  };

  return h("div", { id: "hostPicker", ref: rootRef },
    h("button", {
      id: "hostBtn",
      title: "choose host",
      onClick: (e) => { e.stopPropagation(); state.hostMenuOpen = !state.hostMenuOpen; render(); },
    },
      h("span", { id: "hostDot", class: "hdot" + (cur && cur.online ? "" : " off") }),
      h("span", { id: "hostBtnLabel" }, state.host ?? "no hosts"),
      h("span", { class: "chev" }, "▾"),
    ),
    h("div", { id: "hostDrop", hidden: !state.hostMenuOpen },
      h("div", { id: "hostList" },
        Object.entries(state.hosts).map(([name, host]) =>
          h("div", {
            key: name,
            class: "hostpick" + (name === state.host ? " current" : "") + (host.online ? "" : " off"),
            title: `${name} — ${host.address}` + (host.online ? "" : " (offline)"),
            onClick: () => selectHost(name),
          },
            h("span", { class: "hdot" + (host.online ? "" : " off") }),
            h("span", { class: "hname" }, name),
            h("span", { class: "haddr" }, host.address + (host.online ? "" : " · offline")),
            h("button", {
              class: "rm",
              title: `remove ${name}`,
              onClick: (e) => { e.stopPropagation(); removeHost(name); },
              dangerouslySetInnerHTML: { __html: iconSvg("trash", 12) },
            }),
          )
        ),
      ),
      h("div", { class: "haddrow" },
        h("input", { type: "text", id: "hostName", placeholder: "name", spellcheck: false, ref: nameRef }),
        h("input", {
          type: "text", id: "hostAddr", placeholder: "host:port or folder:/path", spellcheck: false,
          ref: addrRef,
          onKeyDown: (e) => { if (e.key === "Enter") submitAdd(); },
        }),
        h("button", { id: "hostAdd", onClick: submitAdd }, "add"),
      ),
    ),
  );
}
