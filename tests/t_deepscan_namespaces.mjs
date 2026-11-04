import { assertEquals } from "jsr:@std/assert";
import { Settings } from "../src/settings.mjs";
import { Store } from "../src/store.mjs";
import { makeRouter } from "../src/routes.mjs";

Deno.test("settings namespaces and keys are isolated own records, including prototype names after reopen", async () => {
  const dir = await Deno.makeTempDir({ prefix: "settings-dictionaries-" });
  const marker = "deepscanPolluted";
  try {
    let settings = await Settings.open(dir);
    assertEquals(settings.get("constructor", "name", "absent"), "absent");
    assertEquals(settings.get("core.ui", "toString", "absent"), "absent");
    for (const ns of ["__proto__", "constructor", "toString", "core.ui"]) {
      await settings.set(ns, marker, ns);
      await settings.set(ns, "__proto__", { local: ns });
      assertEquals(Object.prototype[marker], undefined);
      assertEquals(Object[marker], undefined);
      assertEquals(settings.get(ns, marker), ns);
      assertEquals(settings.get(ns, "__proto__"), { local: ns });
    }
    settings = await Settings.open(dir);
    for (const ns of ["__proto__", "constructor", "toString", "core.ui"]) {
      assertEquals(settings.get(ns, marker), ns);
      assertEquals(settings.getNs(ns).__proto__, { local: ns });
      await settings.set(ns, marker, null);
      assertEquals(settings.get(ns, marker, "absent"), "absent");
    }
  } finally {
    delete Object.prototype[marker]; delete Object[marker]; delete Object.prototype.local;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("judgment plugin namespaces and fields never resolve or mutate shared prototypes", async () => {
  const dir = await Deno.makeTempDir({ prefix: "judgment-dictionaries-" }), store = await Store.open(dir);
  const marker = "deepscanPolluted";
  try {
    for (const ns of ["__proto__", "constructor", "toString", "plugin"]) {
      assertEquals(store.judgmentPatch("h", "a.png", { [`plugins.${ns}.${marker}`]: ns, [`plugins.${ns}.__proto__`]: { local: ns } }).ok, true);
      assertEquals(Object.prototype[marker], undefined);
      assertEquals(Object[marker], undefined);
      assertEquals(store.judgmentGet("h", "a.png").plugins[ns][marker], ns);
      // The second patch reads the JSON persisted by the first.
      assertEquals(store.judgmentPatch("h", "a.png", { [`plugins.${ns}.next`]: 2 }).ok, true);
      assertEquals(store.judgmentGet("h", "a.png").plugins[ns].__proto__, { local: ns });
      store.judgmentPatch("h", "a.png", { [`plugins.${ns}.${marker}`]: null });
      assertEquals(store.judgmentGet("h", "a.png").plugins[ns][marker], undefined);
    }
  } finally {
    delete Object.prototype[marker]; delete Object[marker]; delete Object.prototype.local;
    store.close(); await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("collection routes reject inherited addresses before inventory, store or backing access", async () => {
  const touched = [], router = makeRouter({ hosts: Object.create({ inherited: "attacker.invalid:80" }),
    inventory: { capture: () => { touched.push("inventory"); } },
    store: new Proxy({}, { get: () => { touched.push("store"); throw new Error("unexpected store access"); } }),
    sourceActivity: { acceptingChanges: () => true } });
  for (const id of ["inherited", "constructor", "toString", "__proto__"]) {
    for (const [method, suffix, body] of [["GET", "/entries"], ["GET", "/entries/a.png"], ["GET", "/entries/a.png/bytes"],
      ["HEAD", "/entries/a.png/bytes"], ["GET", "/entries/a.png/meta"], ["PATCH", "/entries/a.png/judgment", "{}"],
      ["POST", "/entries"], ["DELETE", "/entries/a.png"], ["GET", "/meta"], ["POST", "/want", '{"files":[]}']]) {
      const response = await router.handle(new Request(`http://engine/api/collections/${id}${suffix}`, {
        method, headers: { "Content-Type": "application/json" }, ...(body ? { body } : {}),
      }));
      assertEquals(response.status, 404, `${method} ${id}${suffix}`);
      await response.arrayBuffer();
    }
  }
  assertEquals(touched, []);
});

Deno.test("one settings PATCH serializes and persists once for many fields", async () => {
  const dir = await Deno.makeTempDir({ prefix: "settings-patch-cost-" });
  const stringify = JSON.stringify;
  try {
    const settings = await Settings.open(dir), router = makeRouter({ settings });
    const patch = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`field${i}`, i]));
    const request = new Request("http://engine/api/settings/core.cost", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: stringify(patch) });
    let snapshots = 0;
    JSON.stringify = (value, ...args) => {
      if (value?.version === 1 && Object.hasOwn(value, "data")) snapshots++;
      return stringify(value, ...args);
    };
    const response = await router.handle(request);
    assertEquals(response.status, 200);
    assertEquals(await response.json(), patch);
    assertEquals(snapshots, 1);
    const reopened = await Settings.open(dir);
    assertEquals(reopened.getNs("core.cost"), patch);
    for (const body of [null, [], "wrong", 1]) {
      const invalid = await router.handle(new Request("http://engine/api/settings/core.cost", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: stringify(body) }));
      assertEquals(invalid.status, 400); await invalid.arrayBuffer();
    }
    assertEquals(reopened.getNs("core.cost"), patch);
  } finally { JSON.stringify = stringify; await Deno.remove(dir, { recursive: true }); }
});
