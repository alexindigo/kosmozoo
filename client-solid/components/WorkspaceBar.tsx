// client-solid/components/WorkspaceBar.tsx — the narrow bar at the right
// edge: one button per workspace space (details on top, the default). The
// choice persists; the pane follows store.state.workspace.

import { iconSvg } from "/js/icons.mjs";
import { useAppStore } from "../store/app-store.js";
import { For } from "solid-js";

export function WorkspaceBar() {
  const store = useAppStore();
  return (
    <nav id="wsBar">
      <For each={store.state.workspaceSpaces()}>{space => <button title={space.title} aria-label={space.title}
        data-workspace={space.id} classList={{ on: store.state.workspace() === space.id }}
        onClick={() => store.handles.invoke("workspace.select", { space: space.id })} innerHTML={iconSvg(space.icon, 16)} />}</For>
    </nav>
  );
}
