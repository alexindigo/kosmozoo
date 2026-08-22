// plugins/variations/plugin.mjs — batch parameter sweep from a card.
//
// One route: POST /run — reads the cached PNG's embedded ComfyUI graph,
// generates permutations (cartesian product of enabled ranges, edges
// inclusive, current-image permutation excluded), clones + mutates the
// graph per permutation, and POSTs each to the source host's /api/prompt.

import { parsePngTextChunks, firstNode, scalarInput } from "../../src/extractor.mjs";

// --- parameter → node mapping ------------------------------------------------

// Each parameter knows which graph nodes carry it and how to write the value.
// Reuses the extractor's probe knowledge (firstNode, scalarInput).

const PARAM_PROBES = {
  denoise: {
    // KSampler carries denoise directly; SamplerCustomAdvanced via scheduler.
    set(graph, value) {
      const nodes = Object.values(graph);
      const ks = nodes.find((n) => n.class_type === "KSampler");
      if (ks) { ks.inputs.denoise = value; return true; }
      const sched = firstNode(nodes, "scheduler");
      if (sched && typeof sched.inputs?.denoise === "number") {
        sched.inputs.denoise = value; return true;
      }
      return false;
    },
    get(meta) { return meta.denoise ?? null; },
  },
  cfg: {
    set(graph, value) {
      const nodes = Object.values(graph);
      const ks = nodes.find((n) => n.class_type === "KSampler");
      if (ks) { ks.inputs.cfg = value; return true; }
      const guider = firstNode(nodes, "cfgguider");
      if (guider && typeof guider.inputs?.cfg === "number") {
        guider.inputs.cfg = value; return true;
      }
      return false;
    },
    get(meta) { return meta.cfg ?? null; },
  },
  steps: {
    set(graph, value) {
      const nodes = Object.values(graph);
      const ks = nodes.find((n) => n.class_type === "KSampler");
      if (ks) { ks.inputs.steps = Math.round(value); return true; }
      const sched = firstNode(nodes, "scheduler");
      if (sched && typeof sched.inputs?.steps === "number") {
        sched.inputs.steps = Math.round(value); return true;
      }
      return false;
    },
    get(meta) { return meta.steps ?? null; },
  },
  ipa_weight: {
    set(graph, value) {
      const nodes = Object.values(graph);
      let found = false;
      for (const n of nodes) {
        if (!String(n.class_type ?? "").toLowerCase().includes("ipadapter")) continue;
        if (typeof n.inputs?.weight === "number") {
          n.inputs.weight = value;
          found = true;
        }
      }
      return found;
    },
    get(meta) {
      // meta.ipa_weight may be "0.8" or "0.8+0.6" (multi-node)
      const raw = meta.ipa_weight;
      if (!raw) return null;
      const first = String(raw).split("+")[0];
      const v = parseFloat(first);
      return isNaN(v) ? null : v;
    },
  },
};

// --- permutation engine -------------------------------------------------------

function rangeValues(min, max, step) {
  const values = [];
  // floating-point safe: iterate by index, not by accumulating
  const count = Math.round((max - min) / step) + 1;
  for (let i = 0; i < count; i++) {
    values.push(Math.round((min + i * step) * 1e10) / 1e10);
  }
  return values;
}

function cartesianProduct(arrays) {
  if (arrays.length === 0) return [[]];
  const [first, ...rest] = arrays;
  const restProduct = cartesianProduct(rest);
  const out = [];
  for (const v of first) {
    for (const rp of restProduct) {
      out.push([v, ...rp]);
    }
  }
  return out;
}

export function generatePermutations(ranges, increment, currentValues) {
  const enabled = Object.entries(ranges).filter(([, r]) => r.enabled);
  if (enabled.length === 0) return [];

  const keys = enabled.map(([k]) => k);
  const valueArrays = enabled.map(([, r]) => rangeValues(r.min, r.max, increment));
  const product = cartesianProduct(valueArrays);

  // Exclude the permutation matching the current image's values
  const currentKey = keys.map((k) => String(currentValues[k])).join("|");
  return product.filter((perm) => {
    const key = keys.map((k, i) => String(perm[i])).join("|");
    return key !== currentKey;
  }).map((perm) => Object.fromEntries(keys.map((k, i) => [k, perm[i]])));
}

// --- filename template --------------------------------------------------------

function formatValue(v) {
  // Trim trailing zeros: 0.6500000000 → "0.65", 20.0 → "20"
  return String(parseFloat(Number(v).toFixed(10)));
}

export function templateReplace(template, values, currentValues) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    if (key in values) return formatValue(values[key]);
    if (key in currentValues) return formatValue(currentValues[key]);
    return `{${key}}`; // unknown placeholder left as-is
  });
}

// --- graph mutation ------------------------------------------------------------

function mutateGraph(graph, permutation) {
  const clone = structuredClone(graph);
  const nodes = Object.values(clone);
  const applied = [];
  for (const [param, value] of Object.entries(permutation)) {
    const probe = PARAM_PROBES[param];
    if (!probe) continue;
    if (probe.set(clone, value)) applied.push(param);
  }
  return { graph: clone, applied };
}

// --- filename prefix injection --------------------------------------------------

function setFilenamePrefix(graph, prefix) {
  const nodes = Object.values(graph);
  for (const n of nodes) {
    const ct = String(n.class_type ?? "").toLowerCase();
    if (ct === "saveimage" && n.inputs) {
      n.inputs.filename_prefix = prefix;
    }
  }
}

// --- plugin registration ---------------------------------------------------------

export function register(kz) {
  kz.route("POST", "/run", async (req) => {
    let body;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "JSON body required" }, { status: 400 });
    }

    const { id, host, filename, ranges, increment, prefix, suffix } = body;
    if (!id || !host || !filename || !ranges || !increment) {
      return Response.json({ error: "missing required fields" }, { status: 400 });
    }

    // Resolve host address.
    const addr = kz._hostAddr(host);
    if (!addr) {
      return Response.json({ error: "unknown host" }, { status: 404 });
    }

    // Resolve hash and read cached bytes.
    const hash = kz._hashFor(host, filename);
    if (!hash) {
      return Response.json({ error: "image not ingested (no hash)" }, { status: 404 });
    }
    const bytes = await kz._cacheGet(hash);
    if (!bytes) {
      return Response.json({ error: "image not in cache" }, { status: 404 });
    }

    // Parse the embedded graph.
    const chunks = await parsePngTextChunks(bytes);
    if (!chunks?.prompt) {
      return Response.json({ error: "no embedded ComfyUI graph in this PNG" }, { status: 422 });
    }
    let graph;
    try {
      graph = JSON.parse(chunks.prompt);
    } catch {
      return Response.json({ error: "embedded graph is not valid JSON" }, { status: 422 });
    }

    // Get current parameter values from the graph for template substitution
    // and permutation exclusion.
    const currentValues = {};
    const nodes = Object.values(graph);
    for (const [param, probe] of Object.entries(PARAM_PROBES)) {
      // Re-extract current values from the graph itself (not from metadata,
      // which may be stale or use different node paths).
      if (param === "denoise") {
        const ks = nodes.find((n) => n.class_type === "KSampler");
        currentValues.denoise = ks?.inputs?.denoise
          ?? scalarInput(firstNode(nodes, "scheduler"), "denoise") ?? null;
      } else if (param === "cfg") {
        const ks = nodes.find((n) => n.class_type === "KSampler");
        currentValues.cfg = ks?.inputs?.cfg
          ?? scalarInput(firstNode(nodes, "cfgguider"), "cfg") ?? null;
      } else if (param === "steps") {
        const ks = nodes.find((n) => n.class_type === "KSampler");
        currentValues.steps = ks?.inputs?.steps
          ?? scalarInput(firstNode(nodes, "scheduler"), "steps") ?? null;
      } else if (param === "ipa_weight") {
        const weights = [];
        for (const n of nodes) {
          if (String(n.class_type ?? "").toLowerCase().includes("ipadapter")
              && typeof n.inputs?.weight === "number") {
            weights.push(n.inputs.weight);
          }
        }
        currentValues.ipa_weight = weights.length ? weights[0] : null;
      }
    }

    // Generate permutations.
    const permutations = generatePermutations(ranges, increment, currentValues);
    if (permutations.length === 0) {
      return Response.json({ error: "no permutations (check ranges and increment)" }, { status: 400 });
    }

    // Submit each permutation.
    const errors = [];
    let submitted = 0;
    for (const perm of permutations) {
      const { graph: mutated, applied } = mutateGraph(graph, perm);
      if (applied.length === 0) {
        errors.push({ permutation: perm, error: "no applicable nodes found" });
        continue;
      }

      // Set filename prefix.
      const name = (prefix ?? "") + templateReplace(suffix ?? "", perm, currentValues);
      setFilenamePrefix(mutated, name);

      try {
        const resp = await fetch(`http://${addr}/api/prompt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: mutated }),
        });
        if (!resp.ok) {
          const text = await resp.text();
          errors.push({ permutation: perm, error: `ComfyUI ${resp.status}: ${text.slice(0, 200)}` });
        } else {
          submitted++;
        }
      } catch (e) {
        errors.push({ permutation: perm, error: `fetch failed: ${e.message}` });
      }
    }

    return Response.json({ submitted, total: permutations.length, errors });
  });
}
