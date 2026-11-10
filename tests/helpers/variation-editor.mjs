import { makeVariationEditor } from "../../client-solid/features/variations/editor.js";
import { parameterCatalogue } from "../../src/features/variations/server.mjs";
import { objectInfoView } from "../../src/backings/comfy.mjs";
import { loadImage } from "./comfy-object-info.mjs";
import { generatePermutations, permutationAxes, resolveRelativeRanges } from "../../src/features/variations/shared.mjs";

export function editorRig(overrides = {}) {
  let origin = { source: "fake", address: "fake:8188", kind: "comfy", epoch: "test-epoch", incarnation: "test-incarnation" };
  const context = { origin: { ...origin }, graphHash: "a".repeat(64) };
  // Production-shaped probe: the same catalogue owner and normalized backend
  // declarations as the engine, including LoadImage's listing/upload contract.
  const graph = { n: { class_type: "BasicScheduler", inputs: { denoise: 1, steps: 20 } },
    image: { class_type: "LoadImage", inputs: { image: "origin.png" } },
    choice: { class_type: "Choice", inputs: { value: "first" } },
    text: { class_type: "Text", inputs: { text: "original" } }, submit: { class_type: "Text", inputs: { text: "other" } } };
  const info = { BasicScheduler: { input: { required: { steps: ["INT", {}], denoise: ["FLOAT", {}] } } }, LoadImage: loadImage(["origin.png", "next.png"]),
    Choice: { input: { required: { value: [["first", "second"], {}] } } }, Text: { input: { required: { text: ["STRING", {}] } } } };
  const schema = objectInfoView(info, null);
  const catalogue = { context, ...parameterCatalogue(graph, schema),
    nodes: Object.entries(graph).map(([id, node]) => ({ id, type: node.class_type, title: null, outputs: schema.outputs.get(node.class_type) ?? null })) };
  const requests = [], uploads = [], timers = []; let closes = 0;
  const values = Object.fromEntries([...catalogue.params, ...catalogue.stringParams, ...catalogue.enumParams, ...catalogue.textParams].map(parameter => [parameter.id, parameter.current]));
  const services = {
    inspectImage: async (_host, _file, _current, _kind, origin) => ({ hash: "b".repeat(64), currentHash: "a".repeat(64), origin }),
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
