// Address-owned optional execution facts learned from ordinary Comfy history.
// A filename is matched only as a full output-root path, never by basename.
import { isEntryPath } from "../entry-path.mjs";

const object = value => value && typeof value === "object" && !Array.isArray(value);
const timestamp = value => Number.isSafeInteger(value) && value >= 0;

function executionTime(id, status) {
  if (!object(status) || status.completed !== true || status.status_str !== "success" || !Array.isArray(status.messages)) return null;
  const starts = [], ends = [];
  for (const message of status.messages) {
    if (!Array.isArray(message) || message.length !== 2) continue;
    const [event, data] = message;
    if (event === "execution_error" || event === "execution_interrupted") return null;
    if (event !== "execution_start" && event !== "execution_success") continue;
    if (!object(data) || data.prompt_id !== id || !timestamp(data.timestamp)) return null;
    (event === "execution_start" ? starts : ends).push(data.timestamp);
  }
  return starts.length === 1 && ends.length === 1 && ends[0] >= starts[0] ? ends[0] - starts[0] : null;
}

function outputNames(outputs) {
  const names = new Set();
  if (!object(outputs)) return names;
  for (const node of Object.values(outputs)) {
    if (!object(node)) continue;
    for (const values of Object.values(node)) {
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        if (!object(value) || value.type !== "output" || typeof value.filename !== "string" || value.filename.includes("/") ||
            typeof value.subfolder !== "string") continue;
        const name = value.subfolder ? `${value.subfolder}/${value.filename}` : value.filename;
        if (isEntryPath(name)) names.add(name);
      }
    }
  }
  return names;
}

export function makeGenerationTimes() {
  const prompts = new Map(), outputs = new Map();
  return {
    observe(history) {
      for (const [id, entry] of Object.entries(history)) {
        if (!object(entry)) continue;
        // Replace this prompt's own evidence, retaining distinct producers so an
        // ambiguous reused output name can never silently pick a newest job.
        for (const name of prompts.get(id) ?? []) {
          const producers = outputs.get(name);
          producers.delete(id);
          if (!producers.size) outputs.delete(name);
        }
        const names = outputNames(entry.outputs), ms = executionTime(id, entry.status);
        prompts.set(id, names);
        for (const name of names) {
          if (!outputs.has(name)) outputs.set(name, new Map());
          outputs.get(name).set(id, ms);
        }
      }
    },
    read(name) {
      const producers = outputs.get(name);
      return producers?.size === 1 ? producers.values().next().value : null;
    },
    clear() { prompts.clear(); outputs.clear(); },
  };
}
