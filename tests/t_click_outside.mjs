import { assertEquals } from "jsr:@std/assert";
import { createRoot } from "solid-js";
import { useClickOutside } from "../client-solid/lib/click-outside.js";

function rig() {
  const original = globalThis.document, listeners = new Map(), inside = {}, outside = {}, calls = [];
  const key = (type, capture) => capture ? `${type}:capture` : type;
  globalThis.document = {
    addEventListener: (type, listener, capture) => listeners.set(key(type, capture), listener),
    removeEventListener: (type, listener, capture) => { if (listeners.get(key(type, capture)) === listener) listeners.delete(key(type, capture)); },
  };
  let dispose, attached = true;
  createRoot(cleanup => { dispose = cleanup; useClickOutside(() => ({ contains: node => node === inside && attached }), event => calls.push(event)); });
  return { inside, outside, calls, listeners, detach: () => { attached = false; },
    // Capture, then the event's own handlers (`during`), then bubble.
    fire: (type, target, rest = {}, during = () => {}) => {
      const event = { target, pointerId: 1, detail: 1, ...rest };
      listeners.get(key(type, true))?.(event); during(); listeners.get(type)?.(event);
    },
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

Deno.test("outside click: a keyboard click whose handler unmounts its own inside button stays inside", () => {
  const r = rig();
  try {
    r.fire("click", r.inside, { detail: 0 }, r.detach);
    assertEquals(r.calls.length, 0);
    r.fire("click", r.outside, { detail: 0 }); assertEquals(r.calls.length, 1);
  } finally { r.close(); }
  assertEquals(r.listeners.size, 0);
});
