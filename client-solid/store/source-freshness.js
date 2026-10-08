// Private source-owned freshness: observing a completion is not acknowledging it.
// Only this owner's captured successful reads can advance its accepted target.
const sameTarget = (a, b) => !!a && !!b && a.epoch === b.epoch &&
  a.terminalRevision === b.terminalRevision && a.resyncRevision === b.resyncRevision;

export function makeSourceFreshness() {
  let target = null, accepted = null, sequence = 0, acceptedSequence = 0;
  let retired = false;
  const issued = new WeakSet();
  return {
    observe(snapshot) {
      if (retired || !snapshot?.supported || snapshot.state === "unknown" || typeof snapshot.epoch !== "string" || !snapshot.epoch ||
          !Number.isSafeInteger(snapshot.terminalRevision) || snapshot.terminalRevision < 0 ||
          !Number.isSafeInteger(snapshot.resyncRevision) || snapshot.resyncRevision < 0) return false;
      const next = { epoch: snapshot.epoch, terminalRevision: snapshot.terminalRevision, resyncRevision: snapshot.resyncRevision };
      if (sameTarget(target, next)) return false;
      if (target?.epoch === next.epoch && (next.terminalRevision < target.terminalRevision || next.resyncRevision < target.resyncRevision)) return false;
      target = Object.freeze(next);
      return true;
    },
    target: () => target,
    pending: () => !!target && !sameTarget(target, accepted),
    capture() {
      if (retired) return null;
      const ticket = Object.freeze({ target, sequence: ++sequence });
      issued.add(ticket);
      return ticket;
    },
    accept(ticket) {
      if (retired || !ticket || !issued.delete(ticket) || !ticket.target || ticket.sequence <= acceptedSequence) return false;
      accepted = ticket.target;
      acceptedSequence = ticket.sequence;
      return true;
    },
    retire() { retired = true; target = null; accepted = null; },
  };
}
