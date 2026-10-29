// Session-only inventory observations. No database rows, settings or browser IO.
export class SourceArrivals {
  #listeners = new Set();
  #sources = new Map();
  constructor(store) { this.store = store; }
  subscribe(fn) { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }
  changed(id) { for (const fn of this.#listeners) fn(id); }
  visible(id) {
    const source = this.#sources.get(id);
    if (!source) return [];
    const excluded = new Set(this.store.entriesForCollection(id).filter(row => row.hidden === 1 || row.state === "gone").map(row => row.name));
    return [...source.present].filter(name => !excluded.has(name));
  }
  projection(id) {
    const source = this.#sources.get(id);
    if (!source) return null; // first complete inventory establishes the baseline
    let latestVisibleSeq = 0;
    for (const name of this.visible(id)) latestVisibleSeq = Math.max(latestVisibleSeq, source.names.get(name) ?? 0);
    return { sequence: source.sequence, latestVisibleSeq };
  }
  inventory(id) {
    const source = this.#sources.get(id);
    return source ? { ...this.projection(id), sequences: Object.fromEntries(this.visible(id).map(name => [name, source.names.get(name)])) } : null;
  }
  observe(id, names) {
    const before = JSON.stringify(this.projection(id));
    let source = this.#sources.get(id);
    if (!source) this.#sources.set(id, source = { names: new Map(), present: new Set(), sequence: 0 });
    source.present = new Set(names);
    for (const name of this.visible(id)) if (!source.names.has(name)) source.names.set(name, ++source.sequence);
    if (JSON.stringify(this.projection(id)) !== before) this.changed(id);
  }
  remove(id, name) { if (this.#sources.get(id)?.present.delete(name)) this.changed(id); }
  forget(id) { this.#sources.delete(id); }
}
