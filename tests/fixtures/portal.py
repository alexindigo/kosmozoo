"""Independent private-bus portal fixture; test tooling only (PyGObject)."""
import json
import os
from gi.repository import Gio, GLib

PATH = "/org/freedesktop/portal/desktop"
CHOOSER = "org.freedesktop.portal.FileChooser"
REQUEST = "org.freedesktop.portal.Request"
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
xml = f'''<node><interface name="{CHOOSER}">
<property name="version" type="u" access="read"/>
<method name="OpenFile"><arg type="s" direction="in"/><arg type="s" direction="in"/>
<arg type="a{{sv}}" direction="in"/><arg type="o" direction="out"/></method>
</interface></node>'''
request_xml = f'<node><interface name="{REQUEST}"><method name="Close"/></interface></node>'
log = os.environ["PORTAL_TEST_LOG"]
version = 4

def record(event):
    with open(log, "a", encoding="utf-8") as out:
        out.write(json.dumps(event, ensure_ascii=False) + "\n")

def close(_connection, sender, path, interface, method, params, invocation):
    record({"close": path})
    invocation.return_value(GLib.Variant("()", ()))

def call(_connection, sender, path, interface, method, params, invocation):
    global version
    parent, title, options = params.unpack()
    current = bytes(options.get("current_folder", [])).rstrip(b"\0").decode()
    if current == "/old":
        version = 2
    assert options["directory"] is True and options["multiple"] is False
    assert parent == "" and title == "Choose an image folder"
    token = options["handle_token"]
    assert token.startswith("kosmozoo_")
    handle = f'{PATH}/request/{sender[1:].replace(".", "_")}/{token}'
    if current == "/alternate":
        handle += "_legacy"
    bus.register_object(handle, Gio.DBusNodeInfo.new_for_xml(request_xml).interfaces[0], close, None, None)
    record({"open": current, "handle": handle, "directory": options["directory"]})
    if current != "/wait":
        code = 1 if current == "/cancel" else 2 if current == "/failure" else 0
        uri = "file://foreign/a" if current == "/foreign" else "file:///home/tester/space%20%23%20%C3%A9/%2520"
        # Deliberately emit BEFORE returning OpenFile, exercising the real race.
        bus.emit_signal(sender, handle, REQUEST, "Response", GLib.Variant("(ua{sv})", (code, {
            "uris": GLib.Variant("as", [uri]),
            "choices": GLib.Variant("a(ss)", [("encoding", "utf8")]),
            "current_filter": GLib.Variant("(sa(us))", ("Images", [(0, "*.png")]))})))
    invocation.return_value(GLib.Variant("(o)", (handle,)))

bus.register_object(PATH, Gio.DBusNodeInfo.new_for_xml(xml).interfaces[0], call,
                    lambda *args: GLib.Variant("u", version), None)
bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName",
              GLib.Variant("(su)", ("org.freedesktop.portal.Desktop", 0)), None, Gio.DBusCallFlags.NONE, 3000, None)
record({"ready": True})
GLib.MainLoop().run()
