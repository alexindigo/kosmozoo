// Browser observation only; the registering page lifecycle owns this lifetime.
export function observeNativeMagnification(target, publish) {
  const viewport = target?.visualViewport;
  let active = true, previous;
  function sample() {
    if (!active) return;
    const scale = viewport?.scale;
    const magnified = Number.isFinite(scale) && scale > 1;
    const rect = viewport && [viewport.offsetLeft, viewport.offsetTop, viewport.width, viewport.height].every(Number.isFinite)
      && viewport.width > 0 && viewport.height > 0
      ? { left: viewport.offsetLeft, top: viewport.offsetTop, width: viewport.width, height: viewport.height } : null;
    // One coherent snapshot per change; every registration publishes initially.
    if (previous && magnified === previous.magnified &&
        (rect === null ? previous.rect === null : previous.rect &&
          Object.keys(rect).every(key => rect[key] === previous.rect[key]))) return;
    previous = { magnified, rect };
    publish(previous);
  }
  viewport?.addEventListener("resize", sample);
  viewport?.addEventListener("scroll", sample);
  target?.addEventListener("pageshow", sample);
  sample();
  return () => {
    if (!active) return;
    active = false;
    viewport?.removeEventListener("resize", sample);
    viewport?.removeEventListener("scroll", sample);
    target?.removeEventListener("pageshow", sample);
  };
}
