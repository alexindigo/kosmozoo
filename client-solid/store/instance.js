// client-solid/store/instance.js — THE app store, as a plain ES-module
// singleton. The app (main.tsx) imports it at boot; e2e tests import the
// same served URL (/store/instance.js) and drive the same instance — no
// window global, no proxy.

import { makeAppStore } from "./app-store.js";

export const appStore = makeAppStore();
