import { assert, assertEquals } from "jsr:@std/assert";
import { makeVariationEditor } from "../client-solid/features/variations/editor.js";
import { variationProblem } from "../src/features/variations/problems.mjs";
import { editorRig } from "./helpers/variation-editor.mjs";

Deno.test("editor publication: removing a warned target never renders the previous cohort plan", async () => {
  const basis = editorRig(); basis.editor.dispose();
  const targets = ["a", "b", "c"].map(name => ({ id: `fake:${name}.png`, host: "fake", filename: `${name}.png`, origin: basis.context.origin }));
  const timers = [], observations = [];
  let editor;
  const settle = async () => {
    const timer = timers.findLast(timer => timer.active && timer.ms === 150);
    assert(timer); timer.active = false; await timer.callback();
  };
  editor = makeVariationEditor({ targets, cohortMode: "bulk", currentOrigin: () => basis.context.origin,
    services: { plan: async input => input.targets.map((_, index) => ({ index, count: 1, problem: null,
      counts: { requested: 1, applicable: 1, distinct: 1, excluded: 0, admitted: 1 } })) },
    setTimer: (callback, ms) => { const timer = { callback, ms, active: true }; timers.push(timer); return timer; },
    clearTimer: timer => { timer.active = false; },
    changed: () => {
      if (!editor) return;
      const preview = editor.preview();
      observations.push({ targets: editor.targets().length, count: preview.n, busy: preview.busy });
    } });
  try {
    editor.installCatalogue(basis.catalogue);
    editor.setEnabled("n.steps", true);
    editor.edit("numeric", "n.steps", "mode", "value");
    editor.edit("numeric", "n.steps", "value", "19");
    await settle();
    editor.reportProblem("timing", variationProblem("time-unavailable", { severity: "warning", names: ["a.png"], numbers: { missing: 1, total: 3 }, detail: "missing metadata" }));
    assertEquals(editor.preview().n, 3);
    observations.length = 0;
    assertEquals(editor.removeTarget("fake:a.png"), true);
    assertEquals(editor.targets().map(target => target.id), ["fake:b.png", "fake:c.png"]);
    assert(observations.every(value => value.targets === 2 && (value.count === null || value.count === 2)), JSON.stringify(observations));
    await settle();
    assertEquals(editor.preview().n, 2);
    assertEquals(editor.preview().countChain.split("\n").length, 2);
  } finally { editor.dispose(); }
});
