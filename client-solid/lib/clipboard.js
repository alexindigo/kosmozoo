// The one clipboard owner. The async Clipboard API exists only in secure
// contexts (HTTPS, localhost); plain-HTTP access over the network copies
// synchronously inside the same click instead. A scoped copy handler supplies
// the exact text (a textarea would turn a carriage return into a line feed);
// the selected off-screen buffer only gives the copy command a selection.
export function makeClipboard(win = globalThis) {
  const buffered = text => {
    const doc = win.document;
    if (!doc?.body || typeof doc.execCommand !== "function") return false;
    const focused = doc.activeElement, selection = doc.getSelection?.();
    const saved = selection?.rangeCount === 1
      ? { anchor: selection.anchorNode, anchorOffset: selection.anchorOffset, focus: selection.focusNode, focusOffset: selection.focusOffset }
      : null;
    const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i)) : [];
    const buffer = doc.createElement("textarea");
    buffer.className = "clipboard-buffer"; buffer.value = text;
    buffer.setAttribute("readonly", ""); buffer.setAttribute("aria-hidden", "true"); buffer.tabIndex = -1;
    let supplied = false;
    const supply = event => {
      if (!event.clipboardData) return;
      event.clipboardData.setData("text/plain", text); event.preventDefault(); supplied = true;
    };
    doc.addEventListener?.("copy", supply, true);
    doc.body.append(buffer);
    try {
      buffer.select(); buffer.setSelectionRange(0, buffer.value.length);
      return doc.execCommand("copy") === true && (supplied || buffer.value === text);
    } catch { return false; }
    finally {
      doc.removeEventListener?.("copy", supply, true);
      buffer.remove();
      if (selection) {
        // A single range keeps its direction; several ranges are restored as they were.
        if (saved && typeof selection.setBaseAndExtent === "function") selection.setBaseAndExtent(saved.anchor, saved.anchorOffset, saved.focus, saved.focusOffset);
        else { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range); }
      }
      if (focused && focused !== doc.body) focused.focus?.({ preventScroll: true });
    }
  };
  return async text => {
    const api = win.isSecureContext ? win.navigator?.clipboard : null;
    if (typeof api?.writeText === "function") {
      try { await api.writeText(text); return; }
      catch (error) { if (buffered(text)) return; throw error; }
    }
    if (!buffered(text)) throw new Error("the browser blocked clipboard access");
  };
}

export const copyText = makeClipboard();
