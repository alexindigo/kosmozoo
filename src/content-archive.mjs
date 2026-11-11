// Durable feature-owned bytes, separate from ordinary disposable cache. Every
// reference publication and last-reference removal joins this hash-keyed lock.
import { join, resolve } from "node:path";
import { Cache, sha256, isContentHash } from "./cache.mjs";
import { sniffMime } from "./extractor.mjs";

export class ContentArchive {
  #root; #cache; #locks = new Map();
  constructor(root) { this.#root = resolve(root); this.#cache = new Cache(this.#root); }
  async #directory(path) {
    try { await Deno.mkdir(path, { mode: 0o700 }); }
    catch (error) { if (!(error instanceof Deno.errors.AlreadyExists)) throw error; }
    const stat = await Deno.lstat(path);
    if (!stat.isDirectory || stat.isSymlink) throw new Error("Archive directory is not a private regular directory");
  }
  async #path(hash) {
    if (!isContentHash(hash)) throw new TypeError("Archive key must be a lowercase SHA-256 digest");
    await this.#directory(this.#root);
    await this.#directory(join(this.#root, hash.slice(0, 2)));
    const path = this.#cache.path(hash);
    try { const stat = await Deno.lstat(path); if (!stat.isFile || stat.isSymlink) throw new Error("Archive object is not a regular file"); }
    catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error; }
    return path;
  }
  async #locked(hash, operation) {
    const previous = this.#locks.get(hash) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(operation);
    this.#locks.set(hash, task);
    try { return await task; }
    finally { if (this.#locks.get(hash) === task) this.#locks.delete(hash); }
  }
  async retain(bytes, publish, { hasReferences = () => true, forget = () => {} } = {}) {
    const hash = await sha256(bytes);
    return this.#locked(hash, async () => {
      await this.#path(hash);
      const previous = await this.#cache.get(hash);
      if (previous && (previous.length !== bytes.length || await sha256(previous) !== hash)) throw new Error("Archived bytes are corrupt");
      if (!previous) await this.#cache.put(hash, bytes);
      const record = { hash, bytes: bytes.length, mime: sniffMime(bytes) };
      try { await publish(record); }
      catch (error) {
        if (!previous) {
          try { await this.#collect(hash, () => hasReferences(hash), () => forget(hash)); }
          catch (cleanup) { throw new AggregateError([error, cleanup], "Archive publication and rollback failed", { cause: error }); }
        }
        throw error;
      }
      return record;
    });
  }
  async read(hash) {
    return this.#locked(hash, async () => {
      const path = await this.#path(hash);
      const file = await Deno.open(path, { read: true });
      try {
        const stat = await file.stat();
        if (!stat.isFile) throw new Error("Archive object is not a regular file");
        const bytes = new Uint8Array(await new Response(file.readable).arrayBuffer());
        if (bytes.length !== stat.size || await sha256(bytes) !== hash) throw new Error("Archived bytes are corrupt");
        return bytes;
      } finally { try { file.close(); } catch (error) { if (!(error instanceof Deno.errors.BadResource)) throw error; } }
    });
  }
  async collect(hash, hasReferences, forget) {
    return this.#locked(hash, () => this.#collect(hash, hasReferences, forget));
  }
  async #collect(hash, hasReferences, forget) {
      if (hasReferences()) return false;
      const path = await this.#path(hash);
      try { await Deno.remove(path); } catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error; }
      forget();
      return true;
  }
}
