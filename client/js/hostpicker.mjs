// client/js/hostpicker.mjs — the host picker widget.
//
// Behavior contract: collapsed = status dot + current host name + ▾. Open =
// one row per host (per-host dot, name, mono address, inline × remove) + an
// add row at the bottom (name + host:port + add). Click outside closes.
// Current host is ring-highlighted; offline hosts are dimmed. Selection
// persists; per-host scroll restores on switch.

import { S, render, onRender } from "./state.mjs";
import { api } from "./api.mjs";
import { chrome } from "./chrome.mjs";
import { iconSvg } from "./icons.mjs";

const $ = (id) => document.getElementById(id);

function statusInfo(msg) { chrome.status.info(msg); }
function statusError(msg) { chrome.status.error(msg); }

let selectCallback = null;

export function initHostPicker({ onSelect } = {}) {
  selectCallback = onSelect ?? null;
  $("hostBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    S.hostMenuOpen = !S.hostMenuOpen;
    render();
  });
  document.addEventListener("click", (e) => {
    if (S.hostMenuOpen && !$("hostPicker").contains(e.target)) {
      S.hostMenuOpen = false;
      render();
    }
  });
  $("hostAdd").addEventListener("click", addHost);
  $("hostAddr").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addHost();
  });
}

async function addHost() {
  const name = $("hostName").value.trim();
  const addr = $("hostAddr").value.trim();
  if (!name || !addr) return;
  try {
    await api.addHost(name, addr);
    $("hostName").value = "";
    $("hostAddr").value = "";
    S.hosts = await api.hosts();
    statusInfo(`host ${name} added`);
    render();
  } catch (err) {
    statusError(`host add failed: ${err.message}`);
  }
}

async function removeHost(name) {
  try {
    await api.removeHost(name);
    await api.setSettings("core.ui", { [`scroll.${name}`]: null }).catch(() => {});
    S.hosts = await api.hosts();
    if (S.host === name) await selectHost(Object.keys(S.hosts)[0] ?? null);
    statusInfo(`host ${name} removed`);
    render();
  } catch (err) {
    statusError(`host remove failed: ${err.message}`);
  }
}

export async function selectHost(name) {
  S.host = name;
  S.hostMenuOpen = false;
  api.setSettings("core.ui", { host: name }).catch(() => {});
  // switching hosts reloads the feed from that host (loadCandidates owns
  // fetch + rebuild + scroll restore + summary + metadata poll)
  if (selectCallback) await selectCallback();
  else render();
}

// stored host if still present, else first online, else first
export function initialHost(hosts, stored) {
  if (stored && hosts[stored]) return stored;
  const names = Object.keys(hosts);
  return names.find((n) => hosts[n].online) ?? names[0] ?? null;
}

// --- renderer (the picker's only DOM writer) --------------------------------

onRender((s) => {
  if (typeof document === "undefined") return;
  const cur = s.hosts[s.host];
  $("hostBtnLabel").textContent = s.host ?? "no hosts";
  $("hostDot").classList.toggle("off", !(cur && cur.online));
  const drop = $("hostDrop");
  drop.hidden = !s.hostMenuOpen;
  if (!s.hostMenuOpen) return;

  const list = $("hostList");
  list.innerHTML = "";
  for (const [name, h] of Object.entries(s.hosts)) {
    const row = document.createElement("div");
    row.className = "hostpick" + (name === s.host ? " current" : "") + (h.online ? "" : " off");
    row.title = `${name} — ${h.address}` + (h.online ? "" : " (offline)");
    const dot = document.createElement("span");
    dot.className = "hdot" + (h.online ? "" : " off");
    const nm = document.createElement("span");
    nm.className = "hname";
    nm.textContent = name;
    const addr = document.createElement("span");
    addr.className = "haddr";
    addr.textContent = h.address + (h.online ? "" : " · offline");
    const rm = document.createElement("button");
    rm.className = "rm";
    rm.innerHTML = iconSvg("trash", 12);
    rm.title = `remove ${name}`;
    rm.addEventListener("click", (e) => {
      e.stopPropagation();
      removeHost(name);
    });
    row.append(dot, nm, addr, rm);
    row.addEventListener("click", () => selectHost(name));
    list.appendChild(row);
  }
});
