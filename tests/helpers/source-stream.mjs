// Injected complete snapshots exercise the Store boundary, not native transport.
export const sourceActivity = overrides => ({ epoch: "jobs", supported: true, state: "idle", sampledAt: 1,
  runningCount: 0, queuedCount: 0, runningPromptId: null, progress: null,
  terminalRevision: 0, resyncRevision: 0, historyGap: false, error: null, ...overrides });

export function sourceFrame(sources, revision = 0, epoch = "stream") {
  return { version: 1, epoch, revision, sources: Object.fromEntries(Object.entries(sources).map(([id, value]) => {
    const incarnation = value.incarnation ?? `${id}-lifetime`;
    return [id, { address: value.address ?? "mock:1", kind: value.kind ?? "comfy", incarnation,
      pinned: value.pinned ?? false, autoRefresh: value.autoRefresh ?? true,
      sourceVersion: { epoch, incarnation, attributesRevision: value.attributesRevision ?? 0 },
      activity: value.kind === "folder" ? { supported: false, reason: "No generation jobs for folder sources" } : sourceActivity(value.activity) }];
  })) };
}

export function injectedSourceStream(initial = null) {
  const connections = [];
  return {
    connections,
    subscribe(callbacks) {
      const connection = { callbacks, retired: false, cleanups: 0, resyncs: 0 };
      connections.push(connection);
      if (initial) { callbacks.onSnapshot(structuredClone(initial)); callbacks.onConnection("ready"); }
      const dispose = () => { if (!connection.retired) { connection.retired = true; connection.cleanups++; } };
      dispose.resync = () => { connection.resyncs++; callbacks.onConnection("reconnecting"); };
      return dispose;
    },
    snapshot(frame) { const own = connections.at(-1); own.callbacks.onSnapshot(structuredClone(frame)); own.callbacks.onConnection("ready"); },
    state(value) { connections.at(-1).callbacks.onConnection(value); },
  };
}
