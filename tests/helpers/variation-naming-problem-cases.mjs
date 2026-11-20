const base = { phase: "naming", target: { index: 0, source: "fake", name: "b.png" }, destination: "other", parameter: { id: "n.steps", label: "Output name" }, directory: "folder/" };
export const namingProblemCases = [
  [76, "output-type", { value: 42 }, "b.png, Output name: filename_prefix requires text; received 42.", "field"],
  [77, "output-path", { value: "../bad", detail: "parent path segment" }, 'b.png, Output name: invalid filename_prefix path "../bad" (parent path segment); output directory is "folder/".', "field"],
  [78, "output-directory", { actual: "elsewhere/" }, 'b.png, Output name: filename_prefix must retain the original output directory "folder/"; requested "elsewhere/".', "field"],
  [79, "output-budget", { numbers: { bytes: 205, limit: 200 } }, "b.png, Output name: composed filename_prefix exceeds 200 bytes: selected name plus Prefix/Suffix uses 205 UTF-8 bytes. The selected name was not shortened.", "field"],
  [80, "output-separator", { field: "Prefix", value: "nested/", separator: "/" }, 'b.png, Prefix: Prefix/suffix must stay within the producing directory\'s filename leaf "folder/"; "nested/" contains directory separator "/".', "field"],
  [81, "output-path", { composed: true, value: "folder/../bad", detail: "parent path segment" }, 'b.png, Output name: invalid composed filename_prefix path "folder/../bad" (parent path segment); output directory is "folder/".', "field"],
  [82, "naming-token", { field: "Suffix", token: "{missing}", detail: "unknown parameter" }, 'b.png, Suffix: Unresolved naming token "{missing}" (unknown parameter).', "field"],
  [89, "producer-ambiguous", { numbers: { outputs: 2 } }, 'b.png: Cannot identify an unambiguous producing output directory "folder/"; 2 recorded output nodes match that directory. Nothing was queued for this plan.', "batch"],
  [90, "producer-missing", { node: "save" }, "b.png: Producing output node save is missing from the final workflow. No jobs for this plan were submitted.", "batch"],
  [91, "output-missing", {}, "b.png: No output node in graph; 0 recognized output nodes remain on other. No jobs for this plan were submitted.", "batch"],
  [92, "dynamic-option", { node: "n", value: "invalid" }, 'b.png, Output name, node n: Unknown dynamic option "invalid" on other. No jobs for this plan were queued.', "field"],
  [93, "dynamic-default", { child: "n.branch.value", value: "chosen" }, 'b.png, Output name: No object_info default for n.branch.value in selected branch "chosen" on other. No jobs for this plan were queued.', "field"],
  [94, "mutation-empty", { names: ["Steps", "Model"], numbers: { planned: 2 } }, "b.png: No applicable nodes found for Steps, Model; 0 of 2 jobs were sent.", "batch"],
  [95, "mutation-lost", { names: ["Steps", "Model"], numbers: { planned: 2 } }, "b.png: Operation Steps, Model was pruned or overwritten in the final graph by the selected branch/output; 0 of 2 jobs were sent.", "batch"],
].map(([row, code, context, message, location]) => ({ row, code, context: { ...base, ...context }, message, location }));
