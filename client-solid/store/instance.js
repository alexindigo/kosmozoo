// client-solid/store/instance.js — THE app store, as a plain ES-module
// singleton. The app (main.tsx) imports it at boot; e2e tests import the
// same served URL (/store/instance.js) and drive the same instance — no
// window global, no proxy.
//
// makeAppStore runs inside createRoot: the store is a long-lived
// singleton, so its memos and effects need a permanent owner. Without one,
// Solid garbage-collects ownerless computations once unobserved — the
// reactive graph silently freezes after the first few runs.

import { createRoot } from "solid-js";
import { makeAppStore } from "./app-store.js";

export const appStore = createRoot(() => makeAppStore());
