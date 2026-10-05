// The single judgment -> presentation derivation. Consumers never rank states.
const treatments = [
  { name: "favorite", field: "favorite", value: true, color: "var(--attention)" },
  { name: "bookmark", field: "bookmark", value: true, color: "var(--primary)" },
  { name: "down", field: "vote", value: "down", color: "var(--negative)" },
  { name: "up", field: "vote", value: "up", color: "var(--positive-dim)" },
];

export function cardState(judgment, current = false) {
  const active = Object.fromEntries(treatments.map((t) => [t.name, judgment?.[t.field] === t.value]));
  const treatment = treatments.find((t) => active[t.name]);
  const color = treatment?.color ?? (current ? "var(--foreground-bright)" : "var(--focused-background)");
  return {
    current,
    active,
    treatment: treatment?.name ?? (current ? "current" : "none"),
    style: {
      "--card-color": color,
      "--card-glow-color": current ? color : "var(--focused-background)",
    },
  };
}
