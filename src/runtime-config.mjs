// One injected bind/port resolver for source, service and desktop startup.
import { isIP } from "node:net";

export const DEFAULT_PORT = 2084;
const defaults = Object.freeze({ app: "127.0.0.1", serve: "0.0.0.0", source: "0.0.0.0" });

export function browserOrigin({ hostname, port }) {
  const ipv6 = isIP(hostname) === 6;
  const normalized = ipv6 ? new URL(`http://[${hostname}]/`).hostname.slice(1, -1) : hostname.toLowerCase();
  const local = normalized === "localhost" || normalized === "0.0.0.0" || normalized === "::" ||
    normalized === "::1" || /^127\./.test(normalized) || /^::ffff:7f[0-9a-f]{2}:/.test(normalized);
  const destination = local ? "localhost" : ipv6 ? `[${normalized}]` : hostname;
  return `http://${destination}:${port}/`;
}

export function resolveRuntime(mode, env) {
  if (!Object.hasOwn(defaults, mode)) throw new Error(`Unknown engine mode: ${mode}`);
  const explicitPort = Object.hasOwn(env, "KOZMOZOO_PORT"), explicitBind = Object.hasOwn(env, "KOZMOZOO_BIND");
  const rawPort = explicitPort ? env.KOZMOZOO_PORT : String(DEFAULT_PORT);
  if (typeof rawPort !== "string" || !/^[0-9]+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    throw new Error("KOZMOZOO_PORT must be a whole port number from 1 to 65535; empty or malformed overrides are not defaults");
  }
  const hostname = explicitBind ? env.KOZMOZOO_BIND : defaults[mode];
  if (typeof hostname !== "string" || !hostname || hostname !== hostname.trim() || /[\s\x00-\x1f\x7f/\\?#\[\]]/.test(hostname) ||
      !isIP(hostname) && (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.?$/i.test(hostname) || /^[0-9.]+$/.test(hostname))) {
    throw new Error("KOZMOZOO_BIND must be an IP address or hostname, without a port, URL or whitespace");
  }
  const binding = Object.freeze({ hostname, port: Number(rawPort) });
  return Object.freeze({ mode, binding, browserURL: browserOrigin(binding), explicitBind, explicitPort });
}
