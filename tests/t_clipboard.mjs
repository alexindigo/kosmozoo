import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { makeClipboard } from "../client-solid/lib/clipboard.js";
import { makeCommandHandles } from "../client-solid/store/command-handles.js";
import { registerCoreCommands } from "../client-solid/store/core-commands.js";

// A minimal document: one body, focus, a directional selection, copy-event
// listeners and an execCommand that dispatches the copy event.
function fakeWindow({ secure = false, writeText = null, execResult = true, execThrows = false, clipboardData = true, normalize = false } = {}) {
  const log = [], listeners = new Set(), pasted = [];
  const selectionState = { ranges: ["user-range"], anchor: ["end-node", 7], focus: ["start-node", 2] };
  const element = tag => ({ tag, attributes: {}, className: "", _value: "", tabIndex: 0,
    get value() { return this._value; }, set value(text) { this._value = normalize ? text.replace(/\r\n?/g, "\n") : text; },
    setAttribute(name, value) { this.attributes[name] = value; },
    select() { log.push(["select", this.value]); selectionState.ranges = ["buffer"]; },
    setSelectionRange(start, end) { log.push(["range", start, end]); },
    remove() { body.children.splice(body.children.indexOf(this), 1); log.push(["removed"]); },
    focus(options) { log.push(["focus", this.tag, options]); } });
  const body = { children: [], append(child) { this.children.push(child); log.push(["append", child.className]); } };
  const input = element("input");
  const document = {
    body, activeElement: input, createElement: element,
    addEventListener(type, listener) { if (type === "copy") listeners.add(listener); },
    removeEventListener(type, listener) { if (type === "copy") listeners.delete(listener); },
    execCommand(command) {
      log.push(["exec", command, body.children.at(-1)?.value]);
      if (execThrows) throw new Error("not allowed");
      const data = new Map();
      const event = { clipboardData: clipboardData ? { setData: (type, value) => data.set(type, value) } : null, preventDefault() { log.push(["prevent"]); } };
      for (const listener of listeners) listener(event);
      pasted.push(data.get("text/plain") ?? body.children.at(-1)?.value);
      return execResult;
    },
    getSelection: () => ({ get rangeCount() { return selectionState.ranges.length; }, getRangeAt: i => selectionState.ranges[i],
      get anchorNode() { return selectionState.anchor[0]; }, get anchorOffset() { return selectionState.anchor[1]; },
      get focusNode() { return selectionState.focus[0]; }, get focusOffset() { return selectionState.focus[1]; },
      removeAllRanges() { selectionState.ranges = []; }, addRange(range) { selectionState.ranges.push(range); },
      setBaseAndExtent(anchor, anchorOffset, focus, focusOffset) { selectionState.ranges = ["user-range"]; selectionState.anchor = [anchor, anchorOffset]; selectionState.focus = [focus, focusOffset]; log.push(["extent"]); } }),
  };
  return { log, listeners, pasted, selectionState, body, win: { isSecureContext: secure, document, navigator: { clipboard: writeText ? { writeText } : undefined } } };
}

Deno.test("clipboard: a secure context uses the Clipboard API", async () => {
  const written = [];
  const { log, win } = fakeWindow({ secure: true, writeText: async text => { written.push(text); } });
  await makeClipboard(win)("fake/out.png");
  assertEquals(written, ["fake/out.png"]);
  assertEquals(log.filter(entry => entry[0] === "exec"), [], "no buffer copy when the API works");
});

Deno.test("clipboard: plain HTTP copies a selected buffer synchronously and restores focus and selection", async () => {
  const { log, selectionState, listeners, body, win } = fakeWindow({ secure: false, writeText: async () => { throw new Error("must not be used"); } });
  const copying = makeClipboard(win)("fake/sub/out.png");
  // The copy happened before the first await: still inside the user's click.
  assert(log.some(entry => entry[0] === "exec" && entry[1] === "copy" && entry[2] === "fake/sub/out.png"));
  await copying;
  const append = log.find(entry => entry[0] === "append");
  assertEquals(append, ["append", "clipboard-buffer"]);
  assertEquals(body.children, [], "the buffer is removed");
  assertEquals(selectionState.ranges, ["user-range"], "the user's selection is restored");
  assertEquals([selectionState.anchor, selectionState.focus], [["end-node", 7], ["start-node", 2]], "a backward selection keeps its direction");
  assertEquals(listeners.size, 0, "the copy handler is removed");
  assertEquals(log.at(-1)[0], "focus", "focus returns to the previously focused element");
});

Deno.test("clipboard: a rejected Clipboard API falls back to the buffer", async () => {
  const { log, win } = fakeWindow({ secure: true, writeText: async () => { throw new Error("Document is not focused"); } });
  await makeClipboard(win)("x.png");
  assert(log.some(entry => entry[0] === "exec"));
});

Deno.test("clipboard: when nothing can copy, the failure is an error, not silence", async () => {
  for (const options of [{ execResult: false }, { execThrows: true }]) {
    const { body, win } = fakeWindow(options);
    await assertRejects(() => makeClipboard(win)("x.png"), Error, "the browser blocked clipboard access");
    assertEquals(body.children, [], "the buffer is removed after a failed copy");
  }
  await assertRejects(() => makeClipboard({ isSecureContext: false })("x.png"), Error, "the browser blocked clipboard access");
});

Deno.test("entry.copyReference resolves whether it copied and reports a failure", async () => {
  const state = { images: [{ id: "h:a.png" }], imageIdxById: () => new Map([["h:a.png", 0]]), referenceName: image => `ref:${image.id}` };
  const run = async clipboard => {
    const handles = makeCommandHandles(), errors = [];
    registerCoreCommands(handles, { state, clipboard, ops: { diff: {}, status: { error: text => errors.push(text) } } });
    return { result: await handles.invoke("entry.copyReference", { id: "h:a.png" }), errors };
  };
  const copied = [];
  assertEquals(await run(async text => { copied.push(text); }), { result: true, errors: [] });
  assertEquals(copied, ["ref:h:a.png"]);
  assertEquals(await run(async () => { throw new Error("the browser blocked clipboard access"); }),
    { result: false, errors: ["Couldn't copy the file name: the browser blocked clipboard access"] });
  assertEquals(await run(() => { throw new Error("sync failure"); }), { result: false, errors: ["Couldn't copy the file name: sync failure"] });
});

Deno.test("clipboard: the copy handler supplies the exact text, carriage returns included", async () => {
  for (const name of ["plain/name.png", "odd\rname.png"]) {
    const { pasted, win } = fakeWindow({ normalize: true });
    await makeClipboard(win)(name);
    assertEquals(pasted, [name]);
  }
  // Without clipboard data, a buffer that changed the text is not reported as copied.
  const { win } = fakeWindow({ normalize: true, clipboardData: false });
  await assertRejects(() => makeClipboard(win)("odd\rname.png"), Error, "the browser blocked clipboard access");
  const ordinary = fakeWindow({ normalize: true, clipboardData: false });
  await makeClipboard(ordinary.win)("plain.png");
  assertEquals(ordinary.pasted, ["plain.png"]);
});
