// Per-store native-player capabilities. Views retain their elements/state;
// this owner arbitrates playback and resolves keyboard focus via injected ports.
export function makeMediaPlayers({ workbenchOpen, onError = () => {} }) {
  const players = new Set();
  let disposed = false;
  return {
    register(player) {
      if (disposed) return { started() {}, dispose() {} };
      players.add(player);
      return {
        started() {
          if (!players.has(player) || !player.available()) { player.pause(); return; }
          for (const other of players) if (other !== player) other.pause();
        },
        dispose() { players.delete(player); player.pause(); },
      };
    },
    toggle() {
      const workbench = workbenchOpen();
      const eligible = [...players].filter(p => p.workbench === workbench && p.available());
      const player = eligible.find(p => p.focused()) ?? (workbench ? eligible.find(p => p.primary()) : null);
      return player ? player.toggle() : false;
    },
    report(error) { onError(error); },
    dispose() { disposed = true; for (const player of players) player.pause(); players.clear(); },
  };
}
