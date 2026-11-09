// One displayed name for every parameter kind; catalogue identity and current
// values are deliberately outside this presentation-only search surface.
export const parameterName = row => row.displayName ?? `${row.title ?? row.type}.${row.input ?? row.key}`;

export function matchesFieldFilter(row, filter) {
  const query = filter.trim().toLowerCase();
  return !query || parameterName(row).toLowerCase().includes(query);
}
