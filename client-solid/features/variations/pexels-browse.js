// Pexels browsing for one Variations modal mount: readonly listing pages per
// service and search text. It owns no image-set membership; the editor turns
// a chosen photo into a File through its own acquisition lane.

export const SEARCH_DELAY_MS = 300;
const RETAINED_LISTINGS = 24;
const errorText = error => error?.detail || error?.message || String(error);

export function makePexelsBrowse({ api, changed = () => {}, delay = SEARCH_DELAY_MS, timers = globalThis }) {
  const listings = new Map(), shown = new Map();
  let alive = true, timer = null, scheduled = null;
  const keyOf = (service, query) => JSON.stringify([service, query.trim()]);
  const notify = () => { if (alive) changed(); };

  const listing = (service, query) => {
    const key = keyOf(service, query);
    let entry = listings.get(key);
    if (!entry) {
      entry = { service, query: query.trim(), photos: [], byId: new Map(), page: 0, more: true, curated: true, pending: false, error: "", controller: null };
      listings.set(key, entry);
      for (const [old, record] of listings) {
        if (listings.size <= RETAINED_LISTINGS) break;
        if (record !== entry && !record.pending) listings.delete(old);
      }
    }
    return entry;
  };

  async function load(entry) {
    if (!alive || entry.pending || !entry.more || entry.error) return;
    const controller = new AbortController(), page = entry.page + 1;
    Object.assign(entry, { pending: true, controller }); notify();
    try {
      const result = await api.pexelsPhotos(entry.service, entry.query, page, controller.signal);
      if (!alive || entry.controller !== controller) return;
      if (!Array.isArray(result?.photos)) throw new Error("The service sent no photo list");
      for (const photo of result.photos) {
        if (typeof photo?.id !== "string" || entry.byId.has(photo.id)) continue;
        entry.byId.set(photo.id, photo); entry.photos.push(photo.id);
      }
      Object.assign(entry, { page, more: !!result.more, curated: result.curated !== false });
      shown.set(entry.service, entry);
    } catch (error) {
      if (alive && entry.controller === controller && !controller.signal.aborted) entry.error = errorText(error);
    } finally {
      if (entry.controller === controller) { entry.pending = false; entry.controller = null; notify(); }
    }
  }

  const cancelScheduled = () => { if (timer !== null) timers.clearTimeout(timer); timer = null; scheduled = null; };

  return {
    // The visible state for a service and search text. While a new search is
    // pending, the last settled listing for that service stays on screen.
    results(service, query = "") {
      const entry = listings.get(keyOf(service, query));
      const settled = entry && (entry.page > 0 || entry.error) ? entry : shown.get(service) ?? null;
      const waiting = !entry || entry.pending || (scheduled === keyOf(service, query));
      const source = settled ?? entry;
      const searchOnly = !!entry && !entry.query && !entry.curated;
      return {
        files: searchOnly ? [] : source ? [...source.photos] : [],
        pending: waiting && !entry?.error, more: !!entry && entry.page > 0 && entry.more,
        error: entry?.error ?? "", searchOnly,
      };
    },
    photo(service, id) {
      for (const entry of listings.values()) if (entry.service === service && entry.byId.has(id)) return entry.byId.get(id);
      return null;
    },
    // Typing waits for a pause; an empty search (curated) loads at once.
    request(service, query = "") {
      if (!alive) return;
      const key = keyOf(service, query), entry = listing(service, query);
      if (entry.page > 0 || entry.pending || entry.error) { if (scheduled !== key) cancelScheduled(); notify(); return; }
      cancelScheduled();
      for (const other of listings.values()) if (other !== entry && other.service === service && other.page === 0) { other.controller?.abort(); other.controller = null; other.pending = false; }
      if (!entry.query) { load(entry); return; }
      scheduled = key; notify();
      timer = timers.setTimeout(() => { timer = null; scheduled = null; load(entry); }, delay);
    },
    more(service, query = "") { const entry = listings.get(keyOf(service, query)); if (entry?.page > 0) load(entry); },
    retry(service, query = "") {
      const entry = listings.get(keyOf(service, query));
      if (!entry) return this.request(service, query);
      entry.error = ""; load(entry);
    },
    forget(service) {
      for (const [key, entry] of listings) if (entry.service === service) { entry.controller?.abort(); listings.delete(key); }
      shown.delete(service); notify();
    },
    dispose() {
      alive = false; cancelScheduled();
      for (const entry of listings.values()) entry.controller?.abort();
      listings.clear(); shown.clear();
    },
  };
}
