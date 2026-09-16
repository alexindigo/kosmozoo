// src/writer.mjs — one serialized writer per JSON document.
//
// The lost-write race (audit C2): sync stringify → async tmp write → rename
// from overlapping callers (PUT loops, two tabs) lands renames in the wrong
// order and an older snapshot wins. Here every write to one path chains on
// the previous one, and payloads queued while a write is in flight coalesce
// — only the LATEST payload is written after the in-flight write completes.
//
// atomicWrite (state.mjs) stays the durability primitive; it is only ever
// called from here.

import { atomicWrite } from "./state.mjs";

export class SerializedWriter {
  #path;
  #write;
  #tail = Promise.resolve();
  #pending = null;

  constructor(path, write = atomicWrite) {
    this.#path = path;
    this.#write = write; // injectable for tests
  }

  // Queue `bytes` for the path. Resolves once the chain has passed this
  // write — the payload itself may have been superseded by a newer one
  // (that is the coalescing contract: last value wins, disk sees fewer
  // renames than calls). Rejects if the underlying write fails, without
  // poisoning the chain for later writes.
  write(bytes) {
    this.#pending = bytes;
    const task = this.#tail.then(async () => {
      if (this.#pending === null) return; // superseded
      const payload = this.#pending;
      this.#pending = null;
      await this.#write(this.#path, payload);
    });
    this.#tail = task.catch(() => {}); // keep the chain alive past a failure
    return task;
  }
}

// The process-wide registry: even unrelated call sites into the same path
// serialize against each other.
const writers = new Map();

export function writeSerialized(path, bytes) {
  let w = writers.get(path);
  if (!w) {
    w = new SerializedWriter(path);
    writers.set(path, w);
  }
  return w.write(bytes);
}
