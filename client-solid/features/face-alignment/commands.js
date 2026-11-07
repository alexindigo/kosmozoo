export function faceCommands({ choose, toggleDetection, retry, save, edit, cycle }) {
  const exact = (args, fields) => Object.keys(args).length === fields.length && fields.every(f => Object.hasOwn(args, f));
  return [
    { id: "faces.detection.toggle", description: "Toggle face detection", validate: a => exact(a, []), execute: toggleDetection },
    { id: "faces.use", description: "Use selected face for alignment", validate: a => exact(a, ["side", "record", "face"]) &&
      ["a", "b"].includes(a.side) && typeof a.record === "string" && typeof a.face === "string", execute: choose },
    { id: "faces.retry", description: "Retry face detection", validate: a => exact(a, []), execute: retry },
    { id: "faces.settings.edit", validate: a => exact(a, ["value"]) && typeof a.value === "string", execute: a => edit(a.value) },
    { id: "faces.settings.save", description: "Save detector service", validate: a => exact(a, []), execute: save },
    { id: "workbench.alignment.cycle", description: "Cycle comparison alignment", validate: a => exact(a, []), execute: cycle },
  ];
}
