// Modal-private native Tab presentation. No navigation, control state or recipe.
export function horizontalReveal({ viewport, target, left, maximum }) {
  if (![viewport.left, viewport.right, target.left, target.right, left, maximum].every(Number.isFinite)) return left;
  const delta = target.left < viewport.left ? target.left - viewport.left
    : target.right > viewport.right ? target.right - viewport.right : 0;
  return Math.max(0, Math.min(maximum, left + delta));
}

export function makeKeyboardReveal({ schedule, cancel, read, write }) {
  let alive = true, ticket = null;
  const retire = () => { if (ticket !== null) { cancel(ticket.job); ticket = null; } };
  return {
    retire,
    tab(from) {
      retire();
      if (!alive) return;
      const next = { from, target: null, job: null }; ticket = next;
      next.job = schedule(() => { if (ticket === next) ticket = null; });
    },
    focus(target) {
      const next = ticket;
      if (!next) return;
      if (next.target !== null || next.from === target) { retire(); return; }
      cancel(next.job); next.target = target;
      next.job = schedule(() => {
        if (!alive || ticket !== next) return;
        ticket = null;
        const geometry = read(target);
        if (geometry) {
          const left = horizontalReveal(geometry);
          if (left !== geometry.left) write(left);
        }
      });
    },
    dispose() { retire(); alive = false; },
  };
}
