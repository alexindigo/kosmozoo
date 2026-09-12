// client-solid/features/index.js — the client feature registry. Core
// (Card, BulkBar, App) renders feature affordances from this list instead
// of hardcoding them; a feature is imported by name ONLY here.

import * as variations from "./variations/index.js";

export const FEATURES = [variations];

// App.tsx renders this once; each feature's Modal mounts itself when active
export const FeatureModals = () => FEATURES.map((f) => f.Modal ? <f.Modal /> : null);
