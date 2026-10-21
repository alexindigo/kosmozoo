import { makeVariationEditor } from "../../client-solid/features/variations/editor.js";
import { generatePermutations, permutationAxes, resolveRelativeRanges } from "../../src/features/variations/shared.mjs";

export function editorRig(overrides = {}) {
  let origin = { source: "fake", address: "fake:8188", kind: "comfy", epoch: "test-epoch", incarnation: "test-incarnation" };
  const context = { origin: { ...origin }, graphHash: "a".repeat(64) };
  const catalogue = { context,
    params: [{ id: "n.denoise", key: "denoise", current: 1, integer: false, type: "BasicScheduler", nodeIds: ["n"] },
      { id: "n.steps", key: "steps", current: 20, integer: true, type: "BasicScheduler", nodeIds: ["n"] }],
    stringParams: [{ id: "image.image", key: "image", type: "LoadImage", current: "origin.png", nodeIds: ["image"] }],
    enumParams: [{ id: "choice.value", key: "value", type: "Choice", current: "first", values: ["first", "second"], nodeIds: ["choice"] }],
    textParams: [{ id: "text.text", key: "text", type: "Text", current: "original", nodeIds: ["text"] },
      { id: "submit.text", key: "text", type: "Text", current: "other", nodeIds: ["submit"] }],
  };
  const requests = [], uploads = [], timers = []; let closes = 0;
  const values = Object.fromEntries([...catalogue.params, ...catalogue.stringParams, ...catalogue.enumParams, ...catalogue.textParams].map(parameter => [parameter.id, parameter.current]));
  const services = {
    probe: async () => catalogue,
    uploadInput: async (_host, form, expected) => {
      const file = form.get("image"); uploads.push({ file, origin: expected });
      return { name: file.name, origin: { ...expected } };
    },
    run: async request => {
      requests.push(request);
      const ranges = request.relative ? resolveRelativeRanges(request.ranges, values) : request.ranges;
      const permutations = generatePermutations(ranges, values, request.imageParams), axes = permutationAxes(request.ranges, request.imageParams);
      return { ok: true, status: 200, data: { submitted: permutations.length, total: permutations.length, errors: [],
        acknowledgement: { ...request.acknowledgement, target: { id: request.id, host: request.host, filename: request.filename }, context: request.context,
          accepted: permutations.map((permutation, index) => {
            const applied = { ranges: Object.keys(permutation).filter(id => ranges[id]?.enabled), imageParams: Object.keys(permutation).filter(id => request.imageParams[id]?.enabled) };
            return { index, promptId: `test-${requests.length}-${index}`, applied,
              selections: { ranges: [...applied.ranges, ...axes.excluded.ranges], imageParams: [...applied.imageParams, ...axes.excluded.imageParams] }, naming: ["prefix", "suffix"] };
          }) },
      } };
    },
    ...overrides,
  };
  const editor = makeVariationEditor({ targets: [{ id: "fake:image.png", host: "fake", filename: "image.png", origin: { ...origin } }], services,
    currentOrigin: () => origin, close: () => closes++, setTimer: (callback, ms) => { const timer = { callback, ms, active: true }; timers.push(timer); return timer; },
    clearTimer: timer => timer.active = false });
  editor.installCatalogue(catalogue); editor.installInputs({ origin, files: ["origin.png", "next.png"] });
  return { editor, catalogue, context, requests, uploads, timers, services,
    replaceSource: () => { origin = { ...origin, address: "replacement:8188", incarnation: "replacement" }; },
    closeCount: () => closes, fireTimers: () => { for (const timer of timers) if (timer.active) { timer.active = false; timer.callback(); } } };
}
