// The real-browser companion probe covers Chromium. These regressions exercise
// terminal ordering deterministically, including the absent shutdown reply.
import { assert, assertEquals, assertRejects, assertStrictEquals } from "jsr:@std/assert";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const { CDP, collectPageErrors } = createRequire(import.meta.url)("./e2e/cdp.cjs");

class Process extends EventEmitter {
  exitCode = null;
  signalCode = null;
  signals = [];
  exit(code = 0, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
  kill(signal) {
    this.signals.push(signal);
    if (this.killError) throw this.killError;
    if (!this.refuseExit) this.exit(null, signal);
    return !this.refuseExit;
  }
}

async function fixture(run, { connect = true } = {}) {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = class {
    readyState = 0;
    sent = [];
    constructor() {
      queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
    }
    send(data) {
      if (this.sendError) throw this.sendError;
      const message = JSON.parse(data);
      this.sent.push(message);
      this.onSend?.(message);
    }
    reply(id, result = {}, error) {
      this.onmessage({ data: JSON.stringify({ id, result, error }) });
    }
    close() { this.readyState = 3; this.onclose?.(); }
  };
  const proc = new Process();
  const page = new CDP(proc, "ws://fixture", { closeTimeoutMs: 30, killTimeoutMs: 30 });
  try {
    if (connect) await page.connect();
    await run(page, proc, page.ws);
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) proc.exit();
    page.ws?.close();
    globalThis.WebSocket = original;
  }
}

Deno.test("CDP: ordinary result/protocol failure and page-error collection remain observable", () => fixture(async (page, _proc, ws) => {
  ws.onSend = ({ id }) => ws.reply(id, { answer: 42 });
  assertEquals(await page.send("Browser.getVersion"), { answer: 42 });
  ws.onSend = ({ id }) => ws.reply(id, {}, { message: "invalid method" });
  await assertRejects(() => page.send("Invalid.method"), Error, "invalid method");
  ws.onSend = ({ id }) => ws.reply(id);
  const errors = await collectPageErrors(page);
  ws.onmessage({ data: JSON.stringify({ method: "Runtime.exceptionThrown", params: { exceptionDetails: { text: "actual failure" } } }) });
  assertEquals(errors, ["actual failure"]);
  assertEquals(page.pending.size, 0);
}));

Deno.test("CDP: socket closure rejects every pending/new ordinary command", () => fixture(async (page, _proc, ws) => {
  const a = assertRejects(() => page.send("Runtime.evaluate"), Error, "socket closed");
  const b = assertRejects(() => page.send("Page.enable"), Error, "socket closed");
  ws.close();
  await Promise.all([a, b]);
  await assertRejects(() => page.send("Page.navigate"), Error, "socket closed");
  assertEquals(page.pending.size, 0);
  assertEquals(ws.sent.length, 2);
}));

Deno.test("CDP: socket errors after connection reject pending requests", () => fixture(async (page, _proc, ws) => {
  const result = assertRejects(() => page.send("Runtime.evaluate"), Error, "socket error");
  ws.onerror();
  await result;
  assertEquals(page.pending.size, 0);
}));

Deno.test("CDP: process exit also settles an in-flight connection; late socket open cannot revive it", () => fixture(async (page, proc) => {
  const connection = assertRejects(() => page.connect(), Error, "browser exited");
  proc.exit(3);
  await connection;
  await assertRejects(() => page.send("Page.enable"), Error, "browser exited");
  assertEquals(page.pending.size, 0);
}, { connect: false }));

Deno.test("CDP: connection closure settles even before its open event", () => fixture(async (page) => {
  const connection = assertRejects(() => page.connect(), Error, "socket closed");
  page.ws.close();
  await connection;
  await assertRejects(() => page.connect(), Error, "socket closed");
}, { connect: false }));

Deno.test("CDP: browser exit settles requests even without socket-close notification", () => fixture(async (page, proc) => {
  const result = assertRejects(() => page.send("Runtime.evaluate"), Error, "browser exited");
  proc.exit(9);
  await result;
  await assertRejects(() => page.close(), Error, "browser exited");
  assertEquals(page.pending.size, 0);
  assertEquals(proc.signals, []);
}));

Deno.test("CDP: process errors retain the actual failure", () => fixture(async (page, proc) => {
  const result = assertRejects(() => page.send("Page.enable"), Error, "process failure");
  proc.emit("error", new Error("process failure"));
  proc.exit(1);
  await result;
  await assertRejects(() => page.close(), Error, "process failure");
}));

Deno.test("CDP: synchronous send failure clears its request without hiding the error", () => fixture(async (page, _proc, ws) => {
  ws.sendError = new Error("write failed");
  await assertRejects(() => page.send("Page.enable"), Error, "write failed");
  assertEquals(page.pending.size, 0);
  ws.sendError = null;
  ws.onSend = ({ id }) => ws.reply(id);
  assertEquals(await page.send("Page.enable"), {});
}));

Deno.test("CDP: missing Browser.close reply settles on actual exit; repeated close shares one request", () => fixture(async (page, proc, ws) => {
  const ordinary = assertRejects(() => page.send("Runtime.evaluate"), Error, "browser exited");
  ws.onSend = () => queueMicrotask(() => proc.exit());
  const first = page.close();
  assertStrictEquals(page.close(), first);
  await first;
  await ordinary;
  assertStrictEquals(page.close(), first);
  assertEquals(ws.sent.filter((message) => message.method === "Browser.close").length, 1);
  assertEquals(page.pending.size, 0);
  assertEquals(proc.signals, []);
}));

Deno.test("CDP: close reply alone does not complete cleanup or kill a healthy closing browser", () => fixture(async (page, proc, ws) => {
  ws.onSend = ({ id }) => ws.reply(id);
  let settled = false;
  const close = page.close().then(() => { settled = true; });
  await Promise.resolve();
  assert(!settled);
  assertEquals(proc.signals, []);
  proc.exit();
  await close;
}));

Deno.test("CDP: new ordinary commands decline while shutting down", () => fixture(async (page, proc) => {
  const close = page.close();
  await assertRejects(() => page.send("Page.enable"), Error, "browser is closing");
  proc.exit();
  await close;
}));

Deno.test("CDP: unexpected pre-close disconnect remains failure after owned cleanup", () => fixture(async (page, proc, ws) => {
  ws.close();
  await assertRejects(() => page.close(), Error, "socket closed");
  assertEquals(proc.signals, ["SIGKILL"]);
  assertEquals(proc.signalCode, "SIGKILL");
}));

Deno.test("CDP: close protocol errors survive successful process cleanup", () => fixture(async (page, proc, ws) => {
  ws.onSend = ({ id }) => { ws.reply(id, {}, { message: "close refused" }); queueMicrotask(() => proc.exit()); };
  await assertRejects(() => page.close(), Error, "close refused");
}));

Deno.test("CDP: shutdown fallback waits for grace and proves actual exit", () => fixture(async (page, proc) => {
  const close = page.close();
  assertEquals(proc.signals, []);
  await close;
  assertEquals(proc.signals, ["SIGKILL"]);
  assertEquals(proc.signalCode, "SIGKILL");
  assertEquals(page.pending.size, 0);
}));

Deno.test("CDP: failure to terminate cannot be rounded up to successful cleanup", () => fixture(async (page, proc) => {
  proc.refuseExit = true;
  await assertRejects(() => page.close(), Error, "did not exit");
  assertEquals(page.pending.size, 0);
  assertEquals(proc.exitCode, null);
}));

Deno.test("CDP: failed process signal is reported and pending close settles", () => fixture(async (page, proc) => {
  proc.killError = new Error("cannot signal process");
  await assertRejects(() => page.close(), Error, "cannot signal process");
  assertEquals(page.pending.size, 0);
}));

Deno.test("CDP: abnormal exit during requested shutdown is still failure", () => fixture(async (page, proc, ws) => {
  ws.onSend = () => queueMicrotask(() => proc.exit(7));
  await assertRejects(() => page.close(), Error, "shutdown failed (7)");
}));
