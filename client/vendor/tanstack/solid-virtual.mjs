import { elementScroll, observeElementOffset, observeElementRect, windowScroll, observeWindowOffset, observeWindowRect, Virtualizer } from "./virtual-core.mjs";
export * from "./virtual-core.mjs";
import { mergeProps, createSignal, onMount, onCleanup, createComputed } from "../solid/solid.mjs";
function createVirtualizerBase(options) {
  const resolvedOptions = mergeProps(options);
  const instance = new Virtualizer(resolvedOptions);
  // items as an atomic signal value (fresh dense array per version) — the
  // store+keyed-reconcile path could tear (holes) under rapid window slides
  const [virtualItems, setVirtualItems] = createSignal(instance.getVirtualItems());
  const [totalSize, setTotalSize] = createSignal(instance.getTotalSize());
  const handler = {
    get(target, prop) {
      switch (prop) {
        case "getVirtualItems":
          return () => virtualItems();
        case "getTotalSize":
          return () => totalSize();
        default:
          return Reflect.get(target, prop);
      }
    }
  };
  const virtualizer = new Proxy(instance, handler);
  virtualizer.setOptions(resolvedOptions);
  onMount(() => {
    const cleanup = virtualizer._didMount();
    virtualizer._willUpdate();
    onCleanup(cleanup);
  });
  createComputed(() => {
    virtualizer.setOptions(mergeProps(resolvedOptions, options, {
      onChange: (instance2, sync) => {
        var _a;
        instance2._willUpdate();
        setVirtualItems(instance2.getVirtualItems());
        setTotalSize(instance2.getTotalSize());
        (_a = options.onChange) == null ? void 0 : _a.call(options, instance2, sync);
      }
    }));
    virtualizer._willUpdate();
    setVirtualItems(instance.getVirtualItems());
    setTotalSize(instance.getTotalSize());
  });
  return virtualizer;
}
function createVirtualizer(options) {
  return createVirtualizerBase(mergeProps({
    observeElementRect,
    observeElementOffset,
    scrollToFn: elementScroll
  }, options));
}
function createWindowVirtualizer(options) {
  return createVirtualizerBase(mergeProps({
    getScrollElement: () => typeof document !== "undefined" ? window : null,
    observeElementRect: observeWindowRect,
    observeElementOffset: observeWindowOffset,
    scrollToFn: windowScroll,
    initialOffset: () => typeof document !== "undefined" ? window.scrollY : 0
  }, options));
}
export {
  createVirtualizer,
  createWindowVirtualizer
};
//# sourceMappingURL=index.js.map
