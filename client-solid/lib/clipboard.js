// The one clipboard owner. The async Clipboard API exists only in secure
// contexts (HTTPS, localhost); plain-HTTP access over the network copies a
// selected off-screen buffer instead, synchronously inside the same click.
export function makeClipboard(win = globalThis) {
  const buffered = text => {
    const doc = win.document;
    if (!doc?.body || typeof doc.execCommand !== "function") return false;
    const focused = doc.activeElement, selection = doc.getSelection?.();
    const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i)) : [];
    const buffer = doc.createElement("textarea");
    buffer.className = "clipboard-buffer"; buffer.value = text;
    buffer.setAttribute("readonly", ""); buffer.setAttribute("aria-hidden", "true"); buffer.tabIndex = -1;
    doc.body.append(buffer);
    try { buffer.select(); buffer.setSelectionRange(0, text.length); return doc.execCommand("copy") === true; }
    catch { return false; }
    finally {
      buffer.remove();
      if (selection) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range); }
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
