// One resource-rendering contract for receipt-managed and package-owned installs.
// Callers choose locations; rendering has no filesystem, service or browser effects.
import { isAbsolute } from "node:path";

function pathText(path) {
  if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error("Managed paths must be absolute and have no control characters");
  return path;
}
export function systemdArgument(path) {
  return '"' + pathText(path).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%") + '"';
}
export function systemdPath(path) {
  // EnvironmentFile is one path, distinct from ExecStart's argv grammar.
  return pathText(path).replace(/%/g, "%%");
}
export function desktopArgument(path) {
  pathText(path);
  if (path.includes("=")) throw new Error("Desktop executable paths cannot contain '=' under the desktop-entry specification");
  const quoted = '"' + path.replace(/[\\"`$]/g, match => "\\" + match).replace(/%/g, "%%") + '"';
  return quoted.replace(/\\/g, "\\\\");
}

export function renderResources({ unitTemplate, desktopTemplate, executable, icon, environmentFile, userConfig = false }) {
  // A package unit resolves the actual manager's config, never the build HOME.
  const environment = userConfig ? "%E/kosmozoo/engine.env" : systemdPath(environmentFile);
  // One pass over template syntax only: replacements are literal data, including
  // $&/$$ and token-shaped path components. Never rescan injected caller values.
  const render = (template, values) => template.replace(/\{\{([A-Z_]+)\}\}/g, (_token, key) => {
    if (!Object.hasOwn(values, key)) throw new Error("Unresolved installation resource token");
    return values[key];
  });
  const unit = render(unitTemplate, { EXECUTABLE: systemdArgument(executable), ENVIRONMENT_FILE: environment });
  const desktop = render(desktopTemplate, { EXECUTABLE: desktopArgument(executable), ICON: pathText(icon).replace(/\\/g, "\\\\") });
  return { unit, desktop };
}
