// src/hosts.mjs — ComfyUI host registry and proxy.
//
// Multi-host is a core capability (four hosts configured today), so host
// stays part of image identity: keys are `host:filename`.

// Hosts are user config and change over time (spec §5): env seeds the map
// on first boot, then it is user-managed and persisted in settings
// (core.hosts.map). The returned object is mutated in place so every holder
// of the reference (router ctx, scraper) sees changes.
export async function loadHosts(settings, env = Deno.env.toObject()) {
  const existing = settings.get("core.hosts", "map", null);
  if (existing && Object.keys(existing).length) return existing;
  const seed = parseHosts(env);
  await settings.set("core.hosts", "map", seed);
  return seed;
}

const NAME_RE = /^[\w][\w.-]*$/;
const ADDR_RE = /^[\w.-]+:\d+$/;

export function validateHost(name, address) {
  if (!name || !NAME_RE.test(name)) return "bad name (word chars, dots, hyphens)";
  if (!address || !ADDR_RE.test(address)) return "bad address (host:port)";
  return null;
}

export function addHost(map, name, address) {
  map[name] = address;
}

export function removeHost(map, name) {
  delete map[name];
}

export function parseHosts(env = Deno.env.toObject()) {
  // KOZMOZOO_HOSTS: "name=host:port,name2=host2:port2"
  const raw = env.KOZMOZOO_HOSTS ?? "local=127.0.0.1:8188";
  const hosts = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    hosts[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return hosts;
}

export function hostKey(host, filename) {
  return `${host}:${filename}`;
}

export function splitHostKey(key) {
  const i = key.indexOf(":");
  return [key.slice(0, i), key.slice(i + 1)];
}

// Online probe: only the status code of /api/system_stats is inspected.
export async function probeHost(addr) {
  try {
    const r = await fetch(`http://${addr}/api/system_stats`, { signal: AbortSignal.timeout(5000) });
    await r.arrayBuffer();
    return r.status === 200;
  } catch {
    return false;
  }
}

// Proxy image bytes from a host's /api/view.
export async function proxyImage(addr, filename) {
  const url = `http://${addr}/api/view?type=output&filename=${encodeURIComponent(filename)}`;
  const r = await fetch(url);
  if (!r.ok) return { status: r.status };
  const headers = new Headers();
  const ct = r.headers.get("Content-Type");
  const cl = r.headers.get("Content-Length");
  if (ct) headers.set("Content-Type", ct);
  if (cl) headers.set("Content-Length", cl);
  return { status: 200, body: r.body, headers };
}
