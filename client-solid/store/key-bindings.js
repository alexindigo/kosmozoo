// Ordered persisted binding identities; command references and constant data only.
export const CORE_BINDINGS = Object.freeze([
  { id: "app.keys", key: "?", ctx: "global", command: "keys.panel.toggle", desc: "actions & keys panel" },
  { id: "keys.close", key: "Escape", ctx: "keys", route: "keys", command: "keys.panel.close", desc: "close panel" },
  { id: "wb.close", key: "Escape", ctx: "workbench", route: "workbench", command: "workbench.close", desc: "close the workbench" },
  ...[
    ["twoUp", "1", "two-up", "Two-Up"], ["oneUp", "2", "one-up", "One-Up (blink)"],
    ["split", "3", "split", "Split wipe"], ["difference", "4", "difference", "Difference mask"],
  ].map(([id, key, mode, label]) => ({ id: `wb.${id}`, key, ctx: "workbench", route: "workbench-pair", command: "workbench.mode", args: { mode }, desc: `comparator: ${label}` })),
  { id: "wb.colLeft", key: "ArrowLeft", ctx: "workbench", route: "workbench-pair", command: "workbench.column", args: { column: "feed" }, desc: "comparator: feed column" },
  { id: "wb.colRight", key: "ArrowRight", ctx: "workbench", route: "workbench-pair", command: "workbench.column", args: { column: "right" }, desc: "comparator: right column" },
  { id: "wb.prev", key: "ArrowUp", ctx: "workbench", route: "workbench", command: "workbench.step", args: { direction: -1 }, desc: "comparator: step back" },
  { id: "wb.next", key: "ArrowDown", ctx: "workbench", route: "workbench", command: "workbench.step", args: { direction: 1 }, desc: "comparator: step forward" },
  { id: "wb.lock", key: "l", ctx: "workbench", route: "workbench-pair", command: "workbench.lock", args: { toggle: true }, desc: "comparator: lock/unlock entangled zoom" },
]);
