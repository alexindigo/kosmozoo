// src/features/index.mjs — the engine's feature registry. A feature is a
// core module with isolated state (not a drop-in plugin): server.mjs
// exports register(app) where app is the engine surface; its routes mount
// at /api/features/<name>/*. Core never imports a feature by name anywhere
// outside this list.

import * as variations from "./variations/server.mjs";

export const FEATURES = [
  { name: "variations", register: variations.register },
];
