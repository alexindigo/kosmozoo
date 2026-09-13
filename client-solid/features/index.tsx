// client-solid/features/index.js — the client feature registry. Core
// (Card, BulkBar, App) renders feature affordances from this list instead
// of hardcoding them; a feature is imported by name ONLY here.

import * as variations from "./variations/index.js";

// the name lives on the registry entry, mirroring the engine's registry
// (src/features/index.mjs): the store installs a feature's actions under it
export const FEATURES = [
  { name: "variations", ...variations },
];

// App.tsx renders this once; each feature's Modal mounts itself when active
export const FeatureModals = () => FEATURES.map((f) => f.Modal ? <f.Modal /> : null);
