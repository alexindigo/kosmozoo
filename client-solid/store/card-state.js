// The single judgment -> presentation derivation. Consumers never rank states.
const treatments = [
  { name: "favorite", field: "favorite", value: true, color: "var(--attention)" },
  { name: "bookmark", field: "bookmark", value: true, color: "var(--primary)" },
  { name: "down", field: "vote", value: "down", color: "var(--negative)" },
  { name: "up", field: "vote", value: "up", color: "var(--positive)" },
];

// Independent indicators retain every positive judgment, unlike border priority.
export function judgmentMarkers(judgment) {
  const active = cardState(judgment).active;
  return [{ name: "up", label: "up-voted" }, { name: "favorite", label: "starred" }, { name: "bookmark", label: "bookmarked" }]
    .filter(marker => active[marker.name]);
}

export function cardState(judgment, current = false, { surface = "card", unseen = false } = {}) {
  const active = Object.fromEntries(treatments.map((t) => [t.name, judgment?.[t.field] === t.value]));
  const treatment = treatments.find((t) => active[t.name]);
  const color = treatment?.color ?? (current ? "var(--foreground-bright)"
    : surface === "rail" ? "var(--foreground-dim)" : "var(--focused-background)");
  return {
    current,
    unseen: surface === 'rail' && unseen,
    active,
    treatment: treatment?.name ?? (current ? "current" : "none"),
    style: {
      "--card-color": color,
      "--card-glow-color": current ? color : "var(--focused-background)",
    },
  };
}
