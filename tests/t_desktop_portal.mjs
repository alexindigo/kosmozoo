import { assertEquals, assertThrows, assertRejects } from "jsr:@std/assert";
import { encodeMessage, decodeMessage, messageLength } from "../src/desktop/dbus.mjs";
import { directoryPortal, selectedDirectory, CHOOSER_REASON } from "../src/desktop/portal.mjs";
import { register } from "../src/features/variations/server.mjs";

Deno.test("desktop bus: typed portal options and nested optional results retain exact wire values", () => {
  const body = [0, [["uris", ["as", ["file:///home/tester/space%20%23%20%C3%A9"]]], ["choices", ["a(ss)", [["a", "b"]]]], ["current_filter", ["(sa(us))", ["Images", [[0, "*.png"]]]]]]];
  const wire = encodeMessage({ type: 4, serial: 23, path: "/request/a", interface: "org.freedesktop.portal.Request", member: "Response", signature: "ua{sv}", body });
  assertEquals(messageLength(wire.subarray(0, 15)), null);
  assertEquals(messageLength(wire), wire.length);
  assertEquals(decodeMessage(wire).body, body);
  assertThrows(() => decodeMessage(wire.slice(0, -1)), Error, "length");
  const corrupt = wire.slice(); corrupt[0] = 0;
  assertThrows(() => messageLength(corrupt), Error, "protocol");
  // Independent big-endian UINT32 vector: fixed header, signature field,
  // one byte of alignment padding, then the value 42.
  assertEquals(decodeMessage(new Uint8Array([66, 2, 0, 1, 0, 0, 0, 4, 0, 0, 0, 1, 0, 0, 0, 7, 8, 1, 103, 0, 1, 117, 0, 0, 0, 0, 0, 42])).body, [42]);
});
Deno.test("desktop portal: only one local file URI, decoded exactly once", () => {
  assertEquals(selectedDirectory(["file:///home/a%20%23%20%C3%A9/%2520"]), "/home/a # é/%20");
  for (const value of [[], ["https://example.com"], ["file://foreign/a"], ["file:///a#fragment"], ["file:///a%00b"], ["file:///a", "file:///b"]]) assertThrows(() => selectedDirectory(value));
});
Deno.test("desktop portal: server/no-bus capability declines and path stays independently usable", async () => {
  for (const options of [{ mode: "serve", env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/not-accessed" } }, { mode: "app", env: {} }]) {
    const portal = directoryPortal(options);
    assertEquals(await portal.capability(), { available: false, reason: CHOOSER_REASON });
    await assertRejects(() => portal.choose(), Error, CHOOSER_REASON);
  }
});

Deno.test("desktop portal: feature routes forward the owned desktop port, path and request cancellation", async () => {
  const routes = new Map(), calls = [];
  register({ route: (method, path, handler) => routes.set(`${method} ${path}`, handler), desktop: {
    capability: () => ({ available: false, reason: CHOOSER_REASON }),
    choose: options => { calls.push(options); return { path: "/chosen # é", cancelled: false }; },
  } });
  assertEquals(await (await routes.get("GET /folder-chooser")()).json(), { available: false, reason: CHOOSER_REASON });
  const req = new Request("http://test/choose-folder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "/draft" }) });
  assertEquals(await (await routes.get("POST /choose-folder")(req)).json(), { path: "/chosen # é", cancelled: false });
  assertEquals(calls[0].path, "/draft"); assertEquals(calls[0].signal, req.signal);
});

// This integration leg is run explicitly inside the guest with a private real
// dbus-daemon and independent GLib fixture (tests/fixtures/portal.py).
Deno.test({ name: "desktop portal: private real bus and independent portal protocol outcomes", ignore: !Deno.env.get("KOSMOZOO_TEST_PORTAL_BUS"), async fn() {
  const env = { DBUS_SESSION_BUS_ADDRESS: Deno.env.get("KOSMOZOO_TEST_PORTAL_BUS") };
  const portal = directoryPortal({ mode: "app", env, timeout: 3000 });
  assertEquals(await portal.capability(), { available: true, reason: "" });
  const routes = new Map();
  register({ desktop: portal, route: (method, path, handler) => routes.set(`${method} ${path}`, handler) });
  const response = await routes.get("POST /choose-folder")(new Request("http://test/choose-folder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "/success" }) }));
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { path: "/home/tester/space # é/%20", cancelled: false });
  assertEquals(await portal.choose({ path: "/alternate" }), { path: "/home/tester/space # é/%20", cancelled: false });
  assertEquals(await portal.choose({ path: "/cancel" }), { path: null, cancelled: true });
  await assertRejects(() => portal.choose({ path: "/failure" }), Error, "could not choose");
  await assertRejects(() => portal.choose({ path: "/foreign" }), Error, "non-local");
  await assertRejects(() => portal.choose({ path: "relative" }), Error, "absolute");
  const controller = new AbortController();
  const pending = portal.choose({ path: "/wait", signal: controller.signal });
  const timer = setTimeout(() => controller.abort(new Error("test cancelled")), 250);
  try { await assertRejects(() => pending, Error, "test cancelled"); } finally { clearTimeout(timer); }
  await assertRejects(() => directoryPortal({ mode: "app", env, timeout: 150 }).choose({ path: "/wait" }), Error, "timed out");
  const stopping = directoryPortal({ mode: "app", env });
  const stopped = stopping.choose({ path: "/wait" });
  const stopTimer = setTimeout(() => stopping.stop(), 200);
  try { await assertRejects(() => stopped, Error, "stopping"); } finally { clearTimeout(stopTimer); }
  assertEquals(await stopping.capability(), { available: false, reason: CHOOSER_REASON });
  await portal.choose({ path: "/old" });
  assertEquals(await portal.capability(), { available: false, reason: CHOOSER_REASON });
  await assertRejects(() => portal.choose(), Error, CHOOSER_REASON);
} });
