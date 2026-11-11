import { assertEquals, assertThrows } from "jsr:@std/assert";
import { makeWorkspaceSpaces } from "../client-solid/store/workspace-spaces.js";
import { pairSides } from "../client-solid/features/diff/pair.mjs";
import { makeAppStore } from "../client-solid/store/app-store.js";

Deno.test("workspace catalogue: feature candidate resolves only after registration and unknown falls back", () => {
  const spaces = makeWorkspaceSpaces("history"), component = () => null;
  assertEquals(spaces.resolve(), "details");
  spaces.register([{ id: "history", title: "History", icon: "history", component }]);
  assertEquals(spaces.resolve(), "history"); assertEquals(spaces.list().length, 3);
  assertThrows(() => spaces.register([{ id: "history", title: "Duplicate", icon: "history", component }]));
  assertEquals(makeWorkspaceSpaces("missing").resolve(), "details");
});
Deno.test("workspace commands: membership is live, only selected contribution mounts, third spaces have no implicit comparator", () => {
  const store = makeAppStore({ subscribeSources: null });
  store.actions.features.register({ name: "dummy", install: () => ({ workspaceSpaces: [{ id: "dummy", title: "Dummy", icon: "info-circle", component: () => null }] }) });
  store.handles.invoke("workspace.select", { space: "dummy" });
  assertEquals(store.state.workspace(), "dummy");
  assertThrows(() => store.handles.invoke("workspace.select", { space: "unknown" }));
  assertEquals(pairSides({ workspace: "dummy", current: { remote: "fake", image: "a.png" }, nodeImages: [{ file: "b.png" }], infoFile: "b.png" }).b, null);
  store.dispose();
});
