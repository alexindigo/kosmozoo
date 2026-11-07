// client-solid/features/index.js — the client feature registry. Core
// (Card, BulkBar, App) renders feature affordances from this list instead
// of hardcoding them; a feature is imported by name ONLY here.

import * as variations from "./variations/index.js";
import * as faceAlignment from "./face-alignment/index.js";
import { For } from "solid-js";
import { Dynamic } from "solid-js/web";

// the name lives on the registry entry, mirroring the engine's registry
// (src/features/index.mjs): installation contributes commands and public ports
export const FEATURES = [
  { name: "variations", ...variations },
  { name: "face-alignment", ...faceAlignment },
];

// App.tsx renders this once; each feature's Modal mounts itself when active
export const FeatureModals = () => FEATURES.map((f) => f.Modal ? <f.Modal /> : null);

// Bounded public contribution slots, installed before rendering. Components
// receive capabilities and data; core never imports a feature by name.
export function FeatureContributions(props) {
  return <For each={props.store.state.featureContributions(props.slot)}>{entry =>
    <Dynamic component={entry.component} ports={entry.ports} handles={props.store.handles}
      matches={props.matches} side={props.side} accepted={props.accepted} geometry={props.geometry} />
  }</For>;
}
