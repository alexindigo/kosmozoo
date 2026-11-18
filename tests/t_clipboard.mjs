import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { makeClipboard } from "../client-solid/lib/clipboard.js";
import { makeCommandHandles } from "../client-solid/store/command-handles.js";
import { registerCoreCommands } from "../client-solid/store/core-commands.js";

// A minimal document: one body, focus, a selection with ranges and execCommand.
function fakeWindow({ secure = false, writeText = null, execResult = true, execThrows = false } = {}) {
  const log = [], ranges = ["user-range"];
  const element = tag => ({ tag, attributes: {}, className: "", value: "", tabIndex: 0,
    setAttribute(name, value) { this.attributes[name] = value; },
    select() { log.push(["select", this.value]); },
    setSelectionRange(start, end) { log.push(["range", start, end]); },
    remove() { body.children.splice(body.children.indexOf(this), 1); log.push(["removed"]); },
    focus(options) { log.push(["focus", this.tag, options]); } });
  const body = { children: [], append(child) { this.children.push(child); log.push(["append", child.className]); } };
  const input = element("input");
  const document = {
    body, activeElement: input, createElement: element,
    execCommand(command) {
      log.push(["exec", command, body.children.at(-1)?.value]);
      if (execThrows) throw new Error("not allowed");
      return execResult;
    },
    getSelection: () => ({ get rangeCount() { return ranges.length; }, getRangeAt: i => ranges[i],
      removeAllRanges() { log.push(["clearRanges"]); ranges.length = 0; }, addRange(range) { ranges.push(range); log.push(["addRange", range]); } }),
  };
  return { log, ranges, body, win: { isSecureContext: secure, document, navigator: { clipboard: writeText ? { writeText } : undefined } } };
}

Deno.test("clipboard: a secure context uses the Clipboard API", async () => {
  const written = [];
  const { log, win } = fakeWindow({ secure: true, writeText: async text => { written.push(text); } });
  await makeClipboard(win)("fake/out.png");
  assertEquals(written, ["fake/out.png"]);
  assertEquals(log.filter(entry => entry[0] === "exec"), [], "no buffer copy when the API works");
});

Deno.test("clipboard: plain HTTP copies a selected buffer synchronously and restores focus and selection", async () => {
  const { log, ranges, body, win } = fakeWindow({ secure: false, writeText: async () => { throw new Error("must not be used"); } });
  const copying = makeClipboard(win)("fake/sub/out.png");
  // The copy happened before the first await: still inside the user's click.
  assert(log.some(entry => entry[0] === "exec" && entry[1] === "copy" && entry[2] === "fake/sub/out.png"));
  await copying;
  const append = log.find(entry => entry[0] === "append");
  assertEquals(append, ["append", "clipboard-buffer"]);
  assertEquals(body.children, [], "the buffer is removed");
  assertEquals(ranges, ["user-range"], "the user's selection is restored");
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
