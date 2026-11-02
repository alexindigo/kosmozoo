// Session-only inventory observations. No database rows, settings or browser IO.
export class SourceArrivals {
  #listeners = new Set();
  #sources = new Map();
  constructor(store) { this.store = store; }
  subscribe(fn) { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }
  changed(id) {
    const source = this.#sources.get(id);
    if (!source) return;
    let latestVisibleSeq = 0;
    for (const name of this.visible(id)) latestVisibleSeq = Math.max(latestVisibleSeq, source.names.get(name) ?? 0);
    const next = { sequence: source.sequence, latestVisibleSeq }, before = source.projection;
    if (before?.sequence === next.sequence && before.latestVisibleSeq === next.latestVisibleSeq) return;
    source.projection = next;
    for (const fn of this.#listeners) fn(id);
  }
  visible(id) {
    const source = this.#sources.get(id);
    if (!source) return [];
    const excluded = new Set([...this.store.hiddenNames(id), ...this.store.goneNames(id)]);
    return [...source.present].filter(name => !excluded.has(name));
  }
  projection(id) {
    // Jobs progress/snapshot readers never query rows or walk the inventory.
    const projection = this.#sources.get(id)?.projection;
    return projection ? { ...projection } : null;
  }
  inventory(id) {
    const source = this.#sources.get(id);
    return source ? { ...this.projection(id), sequences: Object.fromEntries(this.visible(id).map(name => [name, source.names.get(name)])) } : null;
  }
  observe(id, names) {
    let source = this.#sources.get(id);
    if (!source) this.#sources.set(id, source = { names: new Map(), present: new Set(), sequence: 0, projection: null });
    source.present = new Set(names);
    for (const name of this.visible(id)) if (!source.names.has(name)) source.names.set(name, ++source.sequence);
    this.changed(id);
  }
  remove(id, name) { if (this.#sources.get(id)?.present.delete(name)) this.changed(id); }
  forget(id) { this.#sources.delete(id); }
}
