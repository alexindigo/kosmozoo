// Session-only inventory observations. No database rows, settings or browser IO.
export class SourceArrivals {
  #listeners = new Set();
  #sources = new Map();
  constructor(store) { this.store = store; }
  subscribe(fn) { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }
  changed(id) {
    const source = this.#sources.get(id);
    if (!source) return;
    const sequences = this.visible(id).map(name => source.names.get(name)).sort((a,b) => a-b);
    const visibleRanges = [];
    for (const sequence of sequences) {
      const last = visibleRanges.at(-1);
      if (last && last[1] + 1 === sequence) last[1] = sequence; else visibleRanges.push([sequence, sequence]);
    }
    const latestVisibleSeq = sequences.at(-1) ?? 0, before = source.projection;
    if (before?.sequence === source.sequence && JSON.stringify(before.visibleRanges) === JSON.stringify(visibleRanges)) return;
    const next = Object.freeze({ sequence: source.sequence, latestVisibleSeq,
      revision: (before?.revision ?? 0) + 1, visibleRanges: Object.freeze(visibleRanges.map(Object.freeze)) });
    source.projection = next;
    source.wire = JSON.stringify(next);
    for (const fn of this.#listeners) fn(id);
  }
  visible(id) {
    const source = this.#sources.get(id);
    if (!source) return [];
    const excluded = new Set([...this.store.hiddenNames(id), ...this.store.goneNames(id)]);
    return [...source.present].filter(name => !excluded.has(name));
  }
  projection(id, items = false) {
    // Jobs progress/snapshot readers never query rows or walk the inventory.
    const projection = this.#sources.get(id)?.projection;
    return !projection ? null : items ? projection : { sequence: projection.sequence, latestVisibleSeq: projection.latestVisibleSeq };
  }
  wire(id) { return this.#sources.get(id)?.wire ?? 'null'; }
  inventory(id) {
    const source = this.#sources.get(id);
    return source ? { ...this.projection(id, true), sequences: Object.fromEntries(this.visible(id).map(name => [name, source.names.get(name)])) } : null;
  }
  observe(id, names, token) {
    let source = this.#sources.get(id);
    if (!source || source.token !== token) this.#sources.set(id, source = { token, names: new Map(), present: new Set(), sequence: 0, projection: null });
    source.present = new Set(names);
    for (const name of this.visible(id)) if (!source.names.has(name)) source.names.set(name, ++source.sequence);
    this.changed(id);
  }
  remove(id, name) { if (this.#sources.get(id)?.present.delete(name)) this.changed(id); }
  forget(id) { this.#sources.delete(id); }
}
