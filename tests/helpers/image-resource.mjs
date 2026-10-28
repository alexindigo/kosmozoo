// Browser-resource seam for Store logic tests. Loads remain explicitly held;
// constructing a measurement cannot silently change a sparse known-size list.
export function installImageResource() {
  const original = globalThis.Image;
  globalThis.Image = class {
    constructor() { this.naturalWidth = 100; this.naturalHeight = 50; }
    removeAttribute() { this.src = ""; }
  };
  return () => { if (original === undefined) delete globalThis.Image; else globalThis.Image = original; };
}
