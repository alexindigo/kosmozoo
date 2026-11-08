import { assert, assertEquals } from "jsr:@std/assert";
import { createRoot } from "solid-js";
import { makeRuntimeIdentity } from "../client-solid/store/runtime-identity.js";
import { makeAppStore } from "../client-solid/store/app-store.js";
import { api } from "../client/js/api.mjs";

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function clock() {
  let now = 0, id = 0;
  const timers = new Map();
  return {
    timers,
    schedule(fn, delay) { const key = ++id; timers.set(key, { fn, at: now + delay }); return key; },
    cancel(key) { timers.delete(key); },
    async tick(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [key, timer] = next; now = timer.at; timers.delete(key); timer.fn(); await flush();
      }
      now = end;
    },
  };
}
function fixture() {
  const time = clock(), requests = [], values = [];
  const owner = makeRuntimeIdentity({ ...time, publish: value => values.push(value), read: ({ signal }) =>
    new Promise((resolve, reject) => requests.push({ signal, resolve, reject })) });
  return { owner, time, requests, values };
}

Deno.test("runtime identity: one flight, bounded retry intervals, recovery settles without polling", async () => {
  const { owner, time, requests, values } = fixture();
  try {
    owner.start(); owner.start(); owner.resume(); await flush();
    assertEquals(requests.length, 1);
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const count = requests.length;
      requests.at(-1).reject(new Error("offline")); await flush();
      assertEquals(values, []);
      owner.start(); await time.tick(delay - 1); assertEquals(requests.length, count, "no early retry or duplicate start");
      await time.tick(1); assertEquals(requests.length, count + 1);
    }
    requests.at(-1).resolve("v0.4.0 (0123456)"); await flush();
    assertEquals(values, ["v0.4.0 (0123456)"]);
    owner.start(); await time.tick(60000); assertEquals(requests.length, 8, "accepted identity does not poll");
    assertEquals(time.timers.size, 0);
  } finally { owner.dispose(); }
});

Deno.test("runtime identity: suspend cancels retry/read, resume retains last good, retired replies cannot publish", async () => {
  const { owner, time, requests, values } = fixture();
  try {
    owner.start(); await flush(); const old = requests[0];
    owner.suspend(); owner.suspend(); assert(old.signal.aborted);
    await time.tick(60000); assertEquals(requests.length, 1);
    owner.resume(); owner.resume(); await flush(); assertEquals(requests.length, 2);
    requests[1].resolve("v0.4.0-dev"); old.resolve("stale"); await flush();
    assertEquals(values, ["v0.4.0-dev"]);
    owner.suspend(); owner.resume(); await flush();
    requests[2].reject(Error("offline")); await flush();
    assertEquals(values, ["v0.4.0-dev"], "outage cannot erase accepted identity");
    const retiredRetry = [...time.timers.values()][0].fn;
    owner.suspend(); assertEquals(time.timers.size, 0);
    retiredRetry(); await time.tick(60000); assertEquals(requests.length, 3);
    owner.resume(); await flush();
    requests[3].resolve("v0.4.1 (abcdef0)"); await flush();
    assertEquals(values.at(-1), "v0.4.1 (abcdef0)");
  } finally { owner.dispose(); }
});

Deno.test("runtime identity: deadline recovers ignored abort; disposal fences success/failure and queued timers", async () => {
  const { owner, time, requests, values } = fixture();
  owner.start(); await flush();
  await time.tick(9999); assertEquals(requests.length, 1); assert(!requests[0].signal.aborted);
  await time.tick(1); assert(requests[0].signal.aborted);
  await time.tick(1000); assertEquals(requests.length, 2);
  requests[0].resolve("too late"); await flush(); assertEquals(values, []);
  const deadline = [...time.timers.values()][0].fn;
  owner.dispose(); owner.dispose(); assert(requests[1].signal.aborted);
  requests[1].resolve("retired"); deadline(); owner.resume(); owner.start(); await flush(); await time.tick(60000);
  assertEquals(values, []); assertEquals(time.timers.size, 0); assertEquals(requests.length, 2);

  const failed = fixture(); failed.owner.start(); await flush();
  failed.requests[0].reject(Error("offline")); await flush();
  const retry = [...failed.time.timers.values()][0].fn;
  failed.owner.dispose(); retry(); await failed.time.tick(60000);
  assertEquals(failed.requests.length, 1); assertEquals(failed.time.timers.size, 0);
});

Deno.test("runtime identity: empty observation and synchronous transport throw retry instead of clearing identity", async () => {
  const time = clock(), values = []; let calls = 0;
  const owner = makeRuntimeIdentity({ ...time, publish: value => values.push(value), read: () => {
    calls++; if (calls === 1) throw Error("transport"); return calls === 2 ? "" : "v0.4.0-dev";
  } });
  try {
    owner.start(); await flush(); await time.tick(1000); assertEquals(values, []);
    await time.tick(2000); assertEquals(values, ["v0.4.0-dev"]);
  } finally { owner.dispose(); }
});

Deno.test("runtime identity Store: boot is independent; page replacement, retained callbacks and disposal fence identity", async () => {
  const saved = { ...api }, requests = []; let cleanup;
  api.runtime = ({ signal }) => new Promise(resolve => requests.push({ signal, resolve }));
  api.collections = api.nodes = api.settings = api.prefetch = async () => ({});
  const store = createRoot(dispose => { cleanup = dispose; return makeAppStore({ subscribeSources: null, storage: null }); });
  function page() {
    const listeners = new Map();
    return { listeners, addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
      removeEventListener(type, fn) { listeners.get(type)?.delete(fn); }, emit(type) { for (const fn of listeners.get(type) ?? []) fn(); } };
  }
  const first = page(), next = page();
  try {
    const retire = store.actions.lifecycle.registerPage(first);
    await store.actions.boot(); assertEquals(requests.length, 1); assertEquals(store.state.appVersion(), "");
    const callbacks = [...first.listeners.get("pageshow"), ...first.listeners.get("pagehide")];
    store.actions.lifecycle.registerPage(next); await flush();
    assert(requests[0].signal.aborted); assertEquals(requests.length, 2);
    requests[0].resolve({ app: { version: "9.9" } });
    requests[1].resolve({ app: { version: "0.4.0", revision: "0123456789abcdef" } }); await flush();
    assertEquals(store.state.appVersion(), "v0.4.0 (0123456)");
    retire(); for (const fn of callbacks) fn(); await flush();
    assertEquals(requests.length, 2, "retired page callbacks cannot suspend or restart replacement");
    next.emit("pagehide"); next.emit("pageshow"); await flush(); assertEquals(requests.length, 3);
    assertEquals(store.state.appVersion(), "v0.4.0 (0123456)", "resume retains known projection while pending");
    store.dispose(); requests[2].resolve({ app: { version: "8.8" } }); await flush();
    assert(requests[2].signal.aborted); assertEquals(store.state.appVersion(), "v0.4.0 (0123456)");
    next.emit("pageshow"); assertEquals(requests.length, 3);
  } finally { store.dispose(); cleanup(); Object.assign(api, saved); }
});
