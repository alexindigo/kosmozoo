import { fileURLToPath } from "node:url";
import { BUS, BUS_PATH, connectBus } from "./dbus.mjs";

const PORTAL = "org.freedesktop.portal.Desktop", PATH = "/org/freedesktop/portal/desktop";
const CHOOSER = "org.freedesktop.portal.FileChooser", REQUEST = "org.freedesktop.portal.Request";
export const CHOOSER_REASON = "Folder chooser needs the desktop app";
const absolute = path => typeof path === "string" && path.startsWith("/") && !path.includes("\0");
export function selectedDirectory(uris) {
  if (!Array.isArray(uris) || uris.length !== 1 || typeof uris[0] !== "string") throw new Error("Portal returned no single folder");
  const uri = new URL(uris[0]);
  if (uri.protocol !== "file:" || (uri.hostname && uri.hostname !== "localhost") || uri.search || uri.hash) throw new Error("Portal returned a non-local folder");
  const path = fileURLToPath(uri);
  if (!absolute(path)) throw new Error("Portal returned an invalid folder");
  return path;
}

// Each operation owns its connection and deadline. No persistent bus/cache owner,
// and server-only installations never attempt desktop activation.
export function directoryPortal({ mode, env = Deno.env.toObject(), timeout = 300000 } = {}) {
  const active = new Set();
  let stopped = false;
  const allowed = () => !stopped && (typeof mode === "function" ? mode() : mode) === "app" && !!env.DBUS_SESSION_BUS_ADDRESS;
  const open = async signal => {
    const bus = await connectBus(env.DBUS_SESSION_BUS_ADDRESS, signal);
    try {
      const [version] = await bus.call(PORTAL, PATH, "org.freedesktop.DBus.Properties", "Get", "ss", [CHOOSER, "version"]);
      if (version?.[0] !== "u" || version[1] < 3) throw new Error(CHOOSER_REASON);
      const [sender] = await bus.call(BUS, BUS_PATH, BUS, "GetNameOwner", "s", [PORTAL]);
      return { bus, sender };
    } catch (error) { bus.close(); throw error; }
  };
  return {
    stop() { stopped = true; for (const controller of active) controller.abort(new Error("Desktop app is stopping")); },
    async capability() {
      if (!allowed()) return { available: false, reason: CHOOSER_REASON };
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 3000);
      active.add(controller);
      try { const { bus } = await open(controller.signal); bus.close(); return { available: true, reason: "" }; }
      catch { return { available: false, reason: CHOOSER_REASON }; }
      finally { clearTimeout(timer); active.delete(controller); }
    },
    async choose({ path = "", signal } = {}) {
      if (!allowed()) throw Object.assign(new Error(CHOOSER_REASON), { status: 503 });
      if (path !== "" && !absolute(path)) throw Object.assign(new Error("Folder path must be absolute"), { status: 400 });
      const controller = new AbortController();
      active.add(controller);
      let bus, handle, sender, completed = false;
      // Close before disconnecting, including during pending OpenFile/Response.
      const cancel = () => { controller.abort(signal?.reason); };
      const timer = setTimeout(() => controller.abort(new Error("Folder chooser timed out")), timeout);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      try {
        ({ bus, sender } = await open(controller.signal));
        const token = `kosmozoo_${crypto.randomUUID().replaceAll("-", "")}`;
        handle = `${PATH}/request/${bus.name.slice(1).replaceAll(".", "_")}/${token}`;
        bus.request(sender, handle);
        await bus.call(BUS, BUS_PATH, BUS, "AddMatch", "s", [`type='signal',sender='${sender}',interface='${REQUEST}',member='Response'`]);
        const options = [["handle_token", ["s", token]], ["directory", ["b", true]], ["multiple", ["b", false]], ["accept_label", ["s", "Choose folder"]]];
        if (path) options.push(["current_folder", ["ay", [...new TextEncoder().encode(path), 0]]]);
        const [returned] = await bus.call(sender, PATH, CHOOSER, "OpenFile", "ssa{sv}", ["", "Choose an image folder", options]);
        // The subscription covers both modern predicted and old returned handles.
        handle = returned;
        bus.request(sender, handle);
        const result = await bus.response(message => message.type === 4 && message.sender === sender && message.path === handle && message.interface === REQUEST && message.member === "Response");
        completed = true;
        if (result.signature !== "ua{sv}") throw new Error("Invalid folder chooser response");
        const [code, values] = result.body;
        if (code === 1) return { path: null, cancelled: true };
        if (code !== 0) throw new Error("Folder chooser could not choose a folder");
        const uris = values.find(([key]) => key === "uris")?.[1];
        if (uris?.[0] !== "as") throw new Error("Portal returned no folder");
        return { path: selectedDirectory(uris[1]), cancelled: false };
      } catch (error) { throw controller.signal.aborted ? controller.signal.reason ?? new Error("Folder chooser cancelled") : error; }
      finally {
        clearTimeout(timer); signal?.removeEventListener("abort", cancel); active.delete(controller);
        if (bus && handle && !completed) { try { await bus.dismiss(sender, handle); } catch { /* disconnected bus */ } }
        bus?.close();
      }
    },
  };
}
