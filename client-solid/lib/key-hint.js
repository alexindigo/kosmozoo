// Titles share command identities with the catalogue and effective keys with
// the dispatcher. Missing/unbound entries contribute no shortcut claim.
export function keyHint(bindings, title, command, args = {}) {
  const keys = bindings
    .filter(binding => binding.command === command &&
      Object.entries(args).every(([name, value]) => binding.args?.[name] === value))
    .map(binding => binding.key)
    .filter(Boolean)
    .map(key => key.replace(/(^|\+)Escape$/, "$1Esc").replace(/(^|\+) $/, "$1Space"));
  // Retain the existing compact directional label for the default pair.
  const hint = keys.join("/").replace(/^ArrowLeft\/ArrowRight$/, "ArrowLeft/Right");
  return hint ? `${title} (${hint})` : title;
}
