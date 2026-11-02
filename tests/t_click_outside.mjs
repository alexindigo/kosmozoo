import { assertEquals } from "jsr:@std/assert";
import { createRoot } from "solid-js";
import { useClickOutside } from "../client-solid/lib/click-outside.js";

function rig() {
  const original = globalThis.document, listeners = new Map(), inside = {}, outside = {}, calls = [];
  globalThis.document = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type, listener) => { if (listeners.get(type) === listener) listeners.delete(type); },
  };
  let dispose;
  createRoot(cleanup => { dispose = cleanup; useClickOutside(() => ({ contains: node => node === inside }), event => calls.push(event)); });
  return { inside, outside, calls, listeners,
    fire: (type, target, rest = {}) => listeners.get(type)?.({ target, pointerId: 1, detail: 1, ...rest }),
    close() { dispose(); globalThis.document = original; } };
}

Deno.test("outside click: structural inside press survives outside release; the next genuine outside click closes", () => {
  const r = rig();
  try {
    r.fire("pointerdown", r.inside); r.fire("click", r.outside); assertEquals(r.calls.length, 0);
    r.fire("pointerdown", r.outside); r.fire("click", r.outside); assertEquals(r.calls.length, 1);
    r.fire("pointerdown", r.outside); r.fire("click", r.inside); assertEquals(r.calls.length, 1);
  } finally { r.close(); }
  assertEquals(r.listeners.size, 0);
});

Deno.test("outside click: cancelled/foreign pointers and keyboard clicks cannot inherit an inside press", () => {
  const r = rig();
  try {
    r.fire("pointerdown", r.inside); r.fire("pointercancel", r.inside); r.fire("click", r.outside);
    r.fire("pointerdown", r.inside); r.fire("click", r.outside, { pointerId: 2 });
    r.fire("pointerdown", r.inside); r.fire("click", r.outside, { detail: 0 });
    assertEquals(r.calls.length, 3);
  } finally { r.close(); }
});

Deno.test("outside click: blocked decision clicks consume their press without dismissing or contaminating later clicks", () => {
  const r = rig();
  try {
    r.fire("pointerdown", r.inside); r.fire("click", r.outside, { cancelBubble: true });
    assertEquals(r.calls.length, 0);
    r.fire("click", r.outside); assertEquals(r.calls.length, 1);
  } finally { r.close(); }
});
