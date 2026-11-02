// The small wire subset needed by desktop portals. No executable, fd passing,
// discovery daemon or second runtime. See dbus-specification (wire format v1).
const utf8 = new TextEncoder(), text = new TextDecoder("utf-8", { fatal: true });
const LIMIT = 1024 * 1024;
const alignment = type => ({ y: 1, g: 1, v: 1, n: 2, q: 2, x: 8, t: 8, d: 8, "(": 8, "{": 8 }[type[0]] ?? 4);

function types(signature) {
  if (signature.length > 255) throw new Error("D-Bus signature too long");
  let at = 0;
  const one = (depth = 0) => {
    if (depth > 64) throw new Error("D-Bus nesting limit");
    const start = at, code = signature[at++];
    if (code === "a") one(depth + 1);
    else if (code === "(" || code === "{") {
      const end = code === "(" ? ")" : "}";
      let count = 0;
      while (at < signature.length && signature[at] !== end) { one(depth + 1); count++; }
      if (signature[at++] !== end || !count || (code === "{" && count !== 2)) throw new Error("Invalid D-Bus container");
    } else if (!code || !"ybnqiuxtdsogvh".includes(code)) throw new Error("Unsupported D-Bus signature");
    return signature.slice(start, at);
  };
  const result = [];
  while (at < signature.length) result.push(one());
  return result;
}

class Wire {
  constructor(bytes = new Uint8Array(LIMIT), little = true) { this.bytes = bytes; this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); this.at = 0; this.little = little; }
  need(n) { if (n < 0 || this.at + n > this.bytes.length) throw new Error("Truncated or oversized D-Bus message"); }
  align(n) { this.at = Math.ceil(this.at / n) * n; this.need(0); }
  number(type, value, write) {
    const [method, size] = { y: ["Uint8", 1], n: ["Int16", 2], q: ["Uint16", 2], i: ["Int32", 4], u: ["Uint32", 4], b: ["Uint32", 4], h: ["Uint32", 4], x: ["BigInt64", 8], t: ["BigUint64", 8], d: ["Float64", 8] }[type];
    this.need(size);
    if (write) this.view[`set${method}`](this.at, type === "b" ? Number(value) : value, this.little);
    else value = this.view[`get${method}`](this.at, this.little);
    this.at += size;
    if (type === "b") { if (value !== 0 && value !== 1 && value !== false && value !== true) throw new Error("Invalid D-Bus boolean"); return !!value; }
    return value;
  }
  value(type, value, write = false, depth = 0) {
    if (depth > 64) throw new Error("D-Bus nesting limit");
    this.align(alignment(type));
    const code = type[0], nested = (t, v) => this.value(t, v, write, depth + 1);
    if ("ybnqiuxtdh".includes(code)) return this.number(code, value, write);
    if ("sog".includes(code)) {
      const data = write ? utf8.encode(value) : null;
      const length = this.number(code === "g" ? "y" : "u", data?.length, write);
      if (write && (value.includes("\0") || (code === "g" && data.length > 255))) throw new Error("Invalid D-Bus string");
      const n = write ? data.length : length; this.need(n + 1);
      if (write) { this.bytes.set(data, this.at); this.bytes[this.at + n] = 0; }
      else { if (this.bytes[this.at + n] !== 0) throw new Error("Unterminated D-Bus string"); value = text.decode(this.bytes.subarray(this.at, this.at + n)); if (value.includes("\0")) throw new Error("Invalid D-Bus string"); }
      this.at += n + 1;
      if (code === "g") types(value);
      if (code === "o" && !/^(\/|(?:\/[A-Za-z0-9_]+)+)$/.test(value)) throw new Error("Invalid D-Bus object path");
      return value;
    }
    if (code === "v") {
      const signature = nested("g", value?.[0]), parsed = types(signature);
      if (parsed.length !== 1) throw new Error("Invalid D-Bus variant");
      return [signature, nested(parsed[0], value?.[1])];
    }
    if (code === "(" || code === "{") return types(type.slice(1, -1)).map((t, i) => nested(t, value?.[i]));
    if (code === "a") {
      const element = type.slice(1), lengthAt = this.at;
      const n = this.number("u", 0, write); this.align(alignment(element));
      const start = this.at;
      if (write) {
        for (const entry of value) nested(element, entry);
        this.view.setUint32(lengthAt, this.at - start, this.little);
        return value;
      }
      this.need(n); const end = start + n, result = [];
      while (this.at < end) result.push(nested(element));
      if (this.at !== end) throw new Error("Invalid D-Bus array length");
      return result;
    }
    throw new Error("Unsupported D-Bus value");
  }
}

const fields = { path: [1, "o"], interface: [2, "s"], member: [3, "s"], error: [4, "s"], reply: [5, "u"], destination: [6, "s"], sender: [7, "s"], signature: [8, "g"] };
export function encodeMessage({ type = 1, serial, signature = "", body = [], ...header }) {
  const payload = new Wire();
  types(signature).forEach((t, i) => payload.value(t, body[i], true));
  const wire = new Wire();
  for (const n of [108, type, 0, 1]) wire.number("y", n, true);
  wire.number("u", payload.at, true); wire.number("u", serial, true);
  wire.value("a(yv)", Object.entries({ ...header, ...(signature ? { signature } : {}) }).map(([name, value]) => {
    const [code, type] = fields[name]; return [code, [type, value]];
  }), true);
  wire.align(8); wire.need(payload.at); wire.bytes.set(payload.bytes.subarray(0, payload.at), wire.at);
  return wire.bytes.slice(0, wire.at + payload.at);
}

export function messageLength(bytes) {
  if (bytes.length < 16) return null;
  if (![108, 66].includes(bytes[0]) || bytes[3] !== 1) throw new Error("Unsupported D-Bus protocol");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), little = bytes[0] === 108;
  const n = Math.ceil((16 + view.getUint32(12, little)) / 8) * 8 + view.getUint32(4, little);
  if (n > LIMIT) throw new Error("D-Bus message too large");
  return n;
}
export function decodeMessage(bytes) {
  if (messageLength(bytes) !== bytes.length) throw new Error("Invalid D-Bus message length");
  const wire = new Wire(bytes, bytes[0] === 108); wire.at = 8;
  const serial = wire.number("u"), header = {};
  for (const [code, [type, value]] of wire.value("a(yv)")) {
    const entry = Object.entries(fields).find(([, spec]) => spec[0] === code);
    if (entry) { if (entry[1][1] !== type || Object.hasOwn(header, entry[0])) throw new Error("Invalid D-Bus header"); header[entry[0]] = value; }
  }
  wire.align(8);
  const body = types(header.signature ?? "").map(t => wire.value(t));
  if (wire.at !== bytes.length || !serial) throw new Error("Invalid D-Bus body");
  return { type: bytes[1], serial, ...header, body };
}

export const BUS = "org.freedesktop.DBus", BUS_PATH = "/org/freedesktop/DBus";
export async function connectBus(address, signal) {
  // The desktop bus is local. Never follow tcp/exec/autolaunch addresses.
  const entry = address?.split(";").find(value => value.startsWith("unix:"));
  const options = Object.fromEntries((entry?.slice(5) ?? "").split(",").filter(Boolean).map(v => { const at = v.indexOf("="); return [v.slice(0, at), decodeURIComponent(v.slice(at + 1))]; }));
  const path = options.path ?? (options.abstract ? `\0${options.abstract}` : null);
  if (!path) throw new Error("Local session bus unavailable");
  signal?.throwIfAborted();
  const socket = await Deno.connect({ transport: "unix", path });
  let closed = false, buffer = new Uint8Array(), serial = 0;
  const signals = [];
  let request = null;
  const close = () => { if (!closed) { closed = true; socket.close(); signal?.removeEventListener("abort", abort); } };
  let outbound = Promise.resolve();
  const write = bytes => {
    const next = outbound.then(async () => { for (let at = 0; at < bytes.length;) at += await socket.write(bytes.subarray(at)); });
    outbound = next.catch(() => {});
    return next;
  };
  const dismiss = async (destination, path) => {
    if (!closed) await write(encodeMessage({ serial: ++serial, destination, path, interface: "org.freedesktop.portal.Request", member: "Close" }));
  };
  const abort = () => {
    const timer = setTimeout(close, 100);
    (request ? dismiss(...request) : Promise.resolve()).catch(() => {}).finally(() => { clearTimeout(timer); close(); });
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) { close(); signal.throwIfAborted(); }
  const more = async () => {
    const chunk = new Uint8Array(65536), n = await socket.read(chunk);
    if (n === null) throw new Error("Session bus disconnected");
    if (buffer.length + n > LIMIT) throw new Error("D-Bus receive limit");
    const next = new Uint8Array(buffer.length + n); next.set(buffer); next.set(chunk.subarray(0, n), buffer.length); buffer = next;
  };
  const line = async () => {
    while (true) {
      const end = buffer.indexOf(10);
      if (end >= 0) { const value = text.decode(buffer.subarray(0, end + 1)); buffer = buffer.slice(end + 1); return value; }
      if (buffer.length > 4096) throw new Error("D-Bus authentication limit");
      await more();
    }
  };
  const read = async () => {
    while (true) {
      const n = messageLength(buffer);
      if (n !== null && buffer.length >= n) { const frame = buffer.slice(0, n); buffer = buffer.slice(n); return decodeMessage(frame); }
      await more();
    }
  };
  const call = async (destination, path, iface, member, signature = "", body = []) => {
    const id = ++serial;
    await write(encodeMessage({ serial: id, destination, path, interface: iface, member, signature, body }));
    while (true) {
      const message = await read();
      if ((message.type === 2 || message.type === 3) && message.reply === id) {
        if (message.type === 3) throw new Error(`${message.error}: ${message.body[0] ?? member}`);
        return message.body;
      }
      if (message.type === 4) { if (signals.length >= 128) throw new Error("D-Bus signal limit"); signals.push(message); }
    }
  };
  try {
    const uid = [...utf8.encode(String(Deno.uid()))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    await write(utf8.encode(`\0AUTH EXTERNAL ${uid}\r\n`));
    if (!/^OK [a-f0-9]+\r\n$/i.test(await line())) throw new Error("Session bus authentication failed");
    await write(utf8.encode("BEGIN\r\n"));
    const [name] = await call(BUS, BUS_PATH, BUS, "Hello");
    return { name, call, close,
      async response(predicate) {
        while (true) {
          const index = signals.findIndex(predicate);
          if (index >= 0) return signals.splice(index, 1)[0];
          const message = await read(); if (predicate(message)) return message;
        }
      },
      request(destination, path) { request = [destination, path]; },
      dismiss,
    };
  } catch (error) { close(); throw error; }
}
