// Modal-private Space peek: one hovered target and at most one held peek for
// both image lists. Tiles hand over their own surface and a descriptor
// reader; the keydown arrives through the dispatcher's owned command, and the
// active peek alone observes its release (Space up, window blur).
export const PEEK_MARGIN = 32, PEEK_MS = 180;
const NON_TEXT = new Set(["button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit"]);

export const typingTarget = element => !!element && (!!element.isContentEditable ||
  !!element.matches?.("textarea, select") || (!!element.matches?.("input") && !NON_TEXT.has(element.type)));

// Aspect-kept box filling `area` (a viewport or a tile), centred in it.
export function containBox(natural, area, margin = 0) {
  if (!(natural?.width > 0 && natural?.height > 0)) return null;
  const width = Math.max(1, area.width - 2 * margin), height = Math.max(1, area.height - 2 * margin);
  const scale = Math.min(width / natural.width, height / natural.height);
  const w = natural.width * scale, h = natural.height * scale;
  return { left: (area.left ?? 0) + (area.width - w) / 2, top: (area.top ?? 0) + (area.height - h) / 2, width: w, height: h };
}

export const peekBox = (natural, viewport) => containBox(natural, { left: 0, top: 0, width: viewport.width, height: viewport.height }, PEEK_MARGIN);

// Uniform transform (origin top left) that places `box` over `from`; both
// boxes carry the same picture aspect, so the picture never distorts.
export function flipTransform(from, box) {
  if (!from || !box?.width) return "none";
  return `translate(${from.left - box.left}px, ${from.top - box.top}px) scale(${from.width / box.width})`;
}

export function makeImagePeek({ changed = () => {}, typing = typingTarget, host = globalThis } = {}) {
  let hovered = null, target = null, open = false, alive = true, serial = 0, detach = null;
  const usable = registration => !!registration && !!registration.descriptor()?.src;
  const end = () => {
    if (!open) return;
    open = false; detach?.(); detach = null; changed();
  };
  const listen = () => {
    const keyup = event => { if (event.key !== " ") return; event.preventDefault(); end(); };
    host.addEventListener("keyup", keyup, true); host.addEventListener("blur", end);
    detach = () => { host.removeEventListener("keyup", keyup, true); host.removeEventListener("blur", end); };
  };
  const enter = (registration, element) => {
    if (!alive || registration.retired) return;
    registration.element = element; hovered = registration;
    if (open && target !== registration && usable(registration)) { target = registration; serial++; changed(); }
  };
  return {
    state: () => ({ open, target, serial }),
    // A tile's own surface: pointer membership plus a readonly descriptor.
    target(descriptor) {
      const registration = { descriptor, element: null, retired: false,
        rect: () => registration.element?.isConnected ? registration.element.getBoundingClientRect() : null };
      return {
        props: { "data-vz-peek": "", onPointerEnter: event => enter(registration, event.currentTarget),
          onPointerLeave: () => { if (hovered === registration) hovered = null; } },
        retire() {
          registration.retired = true;
          if (hovered === registration) hovered = null;
          // A held peek keeps its picture; its release has no box to return to.
          if (target === registration) registration.element = null;
        },
      };
    },
    // Dispatcher admission: typing keeps Space; repeats never start a peek.
    admits(event) {
      if (!alive) return false;
      if (event.repeat) return open;
      return usable(hovered) && !typing(event.target);
    },
    start() {
      if (!alive || open) return open;
      if (!usable(hovered)) return false;
      open = true; target = hovered; serial++; listen(); changed();
      return true;
    },
    end,
    dispose() { end(); alive = false; hovered = target = null; },
  };
}
