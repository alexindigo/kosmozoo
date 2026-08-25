// client/js/hostpicker.mjs — the host picker's data + actions (service half).
//
// Behavior contract: collapsed = status dot + current host name + ▾. Open =
// one row per host (per-host dot, name, mono address, inline × remove) + an
// add row at the bottom (name + host:port + add). Click outside closes.
// Current host is ring-highlighted; offline hosts are dimmed. Selection lives
// in the URL hash (/#host[#filename]); stored host is a no-hash fallback.
//
// The DOM itself is declared by <HostPicker> (client/app/components); this
// module owns selection, add/remove, and the boot select callback.

import { state } from "./state.mjs";
import { render } from "../app/services/notify.mjs";
import { writeFeedHash } from "./route.mjs";
import { api } from "./api.mjs";
import { chrome } from "./chrome.mjs";

function statusInfo(msg) { chrome.status.info(msg); }
function statusError(msg) { chrome.status.error(msg); }

let selectCallback = null;

export function initHostPicker({ onSelect } = {}) {
  selectCallback = onSelect ?? null;
}

export async function addHost(name, addr) {
  name = (name ?? "").trim();
  addr = (addr ?? "").trim();
  if (!name || !addr) return { ok: false };
  try {
    await api.addHost(name, addr);
    state.hosts = await api.hosts();
    statusInfo(`host ${name} added`);
    render();
    return { ok: true };
  } catch (err) {
    statusError(`host add failed: ${err.message}`);
    return { ok: false };
  }
}

export async function removeHost(name) {
  try {
    await api.removeHost(name);
    state.hosts = await api.hosts();
    if (state.host === name) {
      await selectHost(Object.keys(state.hosts)[0] ?? null);
    }
    statusInfo(`host ${name} removed`);
    render();
  } catch (err) {
    statusError(`host remove failed: ${err.message}`);
  }
}

// keepFile: boot and URL-driven switches arrive with the hash already
// pristine; UI switches drop the file part (it named the old host's image)
export async function selectHost(name, { keepFile } = {}) {
  state.host = name;
  state.hostMenuOpen = false;
  if (!keepFile) writeFeedHash(null);
  api.setSettings("core.ui", { host: name }).catch(() => {});
  // switching hosts reloads the feed from that host (loadCandidates owns
  // fetch + rebuild + recenter + summary + metadata poll)
  if (selectCallback) await selectCallback();
  else render();
}

// stored host if still present, else first online, else first
export function initialHost(hosts, stored) {
  if (stored && hosts[stored]) return stored;
  const names = Object.keys(hosts);
  return names.find((n) => hosts[n].online) ?? names[0] ?? null;
}
