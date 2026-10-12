// tests/e2e/cdp.cjs — minimal Chrome DevTools Protocol driver.
//
// Zero npm dependencies: launches the Playwright image's Chromium headless,
// talks CDP over Node 22's built-in WebSocket. Just enough for this suite:
// navigate, evaluate (awaitPromise + returnByValue), key dispatch, bounded
// polling.

const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const nodePath = require("node:path");
const { temporaryPath } = require("./paths.cjs");

// the browser comes from the Playwright image — its build dir is DISCOVERED
// from the image's own /ms-playwright content, never hand-synced with the
// image tag in run.sh (I5)
function chromiumBin() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const root = "/ms-playwright";
  const dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
  for (const d of dirs) {
    const bin = nodePath.join(root, d, "chrome-linux", "chrome");
    if (fs.existsSync(bin)) return bin;
  }
  throw new Error(`no chromium build found under ${root}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function disconnected(message) {
  return Object.assign(new Error(message), { code: "CDP_DISCONNECTED" });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.on("data", (c) => body += c);
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

class CDP {
  static async launch(port = 9333, { windowSize } = {}) {
    const proc = spawn(chromiumBin(), [
      "--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
      "--disable-gpu", "--hide-scrollbars", "--mute-audio",
      // suites that emulate a viewport wider than the 800×600 default window
      // must size the physical window to fit — Input events beyond it are
      // silently dropped (the diff suite passes 1600,1000 for its 1400×900)
      ...(windowSize ? [`--window-size=${windowSize}`] : []),
      `--remote-debugging-port=${port}`, `--user-data-dir=${temporaryPath(`cdp-profile-${port}`)}`,
      "about:blank",
    ], { stdio: "ignore" });
    for (let i = 0; i < 150; i++) {
      try {
        const list = await getJson(`http://127.0.0.1:${port}/json/list`);
        const page = list.find((t) => t.type === "page");
        if (page) {
          const cdp = new CDP(proc, page.webSocketDebuggerUrl);
          await cdp.connect();
          return cdp;
        }
      } catch { /* not up yet */ }
      await sleep(100);
    }
    proc.kill();
    throw new Error("chromium devtools endpoint did not come up");
  }

  constructor(proc, wsUrl, { closeTimeoutMs = 3000, killTimeoutMs = 3000 } = {}) {
    this.proc = proc;
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.closeTimeoutMs = closeTimeoutMs;
    this.killTimeoutMs = killTimeoutMs;
    this.terminal = null;
    this.closing = false;
    this.closeTask = null;
    this.exit = null;
    this.processError = null;
    this.connectReject = null;
    this.exitTask = new Promise((resolve) => {
      const exited = (code, signal) => {
        this.exit = { code, signal };
        this.disconnect(disconnected(`browser exited (${code ?? signal})`));
        resolve(this.exit);
      };
      proc.once("exit", exited);
      proc.on("error", (error) => {
        this.processError = error;
        this.disconnect(error);
      });
      if (proc.exitCode !== null || proc.signalCode !== null) {
        exited(proc.exitCode, proc.signalCode);
      }
    });
  }

  disconnect(error) {
    this.terminal ??= error;
    this.connectReject?.(error);
    this.connectReject = null;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  connect() {
    if (this.terminal) return Promise.reject(this.terminal);
    return new Promise((resolve, reject) => {
      this.connectReject = reject;
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => {
        this.connectReject = null;
        if (this.terminal) reject(this.terminal);
        else resolve();
      };
      const ended = (error) => { this.disconnect(error); reject(error); };
      this.ws.onerror = () => ended(disconnected("CDP socket error"));
      this.ws.onclose = () => ended(disconnected("CDP socket closed"));
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      };
    });
  }

  send(method, params = {}) {
    if (this.terminal) return Promise.reject(this.terminal);
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(disconnected("CDP socket is not open"));
    if (this.closing && method !== "Browser.close") return Promise.reject(disconnected("browser is closing"));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  // Evaluate an expression; awaits if it returns a promise, returns by value.
  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error("page exception: " + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    }
    return r.result.value;
  }

  async goto(url) {
    await this.send("Page.enable");
    await this.send("Page.navigate", { url });
    await this.poll("document.readyState !== 'loading'", 20000);
  }

  // Bounded polling — a condition that can't become true fails with a
  // timeout instead of freezing the page with an infinite rAF loop.
  async poll(expression, timeoutMs = 10000, intervalMs = 50) {
    const t0 = Date.now();
    for (;;) {
      const v = await this.evaluate(expression);
      if (v) return v;
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(`poll timeout (${timeoutMs}ms): ${expression.slice(0, 90)}`);
      }
      await sleep(intervalMs);
    }
  }

  // App listens on document keydown; synthetic events reach it.
  // mods: { shift, alt, ctrl, meta }.
  async key(key, mods = {}) {
    await this.evaluate(
      `document.dispatchEvent(new KeyboardEvent("keydown", {
        key: ${JSON.stringify(key)}, bubbles: true,
        shiftKey: ${!!mods.shift}, altKey: ${!!mods.alt},
        ctrlKey: ${!!mods.ctrl}, metaKey: ${!!mods.meta},
      })), true`,
    );
  }

  // Mouse via Input domain (synthesizes pointer events too).
  // modBits: alt=1 ctrl=2 meta=4 shift=8.
  async mouse(type, x, y, opts = {}) {
    await this.send("Input.dispatchMouseEvent", {
      type, x, y,
      button: opts.button ?? "left",
      clickCount: opts.clickCount ?? 0,
      modifiers: opts.modifiers ?? 0,
      // widgets that track the pressed-button state (noUiSlider ends a
      // drag on a move with buttons === 0) need the real button mask
      ...(opts.buttons !== undefined ? { buttons: opts.buttons } : {}),
      ...(type === "mouseWheel" ? { deltaX: opts.deltaX ?? 0, deltaY: opts.deltaY ?? 0 } : {}),
    });
  }

  // trusted click on an element's center (I7: real input events, not
  // synthetic dispatchEvent — controls see exactly what a user produces)
  async clickAt(selector) {
    const box = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      // a trusted click lands at viewport coordinates — scroll the target
      // into view first (rows below a scroll container's fold have rects
      // outside the clickable area)
      el.scrollIntoView({ block: "center", inline: "nearest" });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error("clickAt: no element for " + selector);
    await this.mouse("mousePressed", box.x, box.y, { clickCount: 1, buttons: 1 });
    await this.mouse("mouseReleased", box.x, box.y, { clickCount: 1, buttons: 0 });
  }

  // trusted key via the Input domain — for widgets whose handlers ignore
  // synthetic KeyboardEvents (noUiSlider's keyboard support)
  async keyTrusted(key, { code = key, vk = 0 } = {}) {
    for (const type of ["rawKeyDown", "keyUp"]) {
      await this.send("Input.dispatchKeyEvent", {
        type, key, code,
        windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
      });
    }
  }

  async drag(x0, y0, x1, y1, { steps = 6, modifiers = 0 } = {}) {
    await this.mouse("mousePressed", x0, y0, { clickCount: 1, modifiers, buttons: 1 });
    for (let i = 1; i <= steps; i++) {
      await this.mouse("mouseMoved", x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps, { modifiers, buttons: 1 });
      await sleep(16);
    }
    await this.mouse("mouseReleased", x1, y1, { clickCount: 1, modifiers, buttons: 0 });
  }

  waitForExit(timeoutMs) {
    if (this.exit) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.exitTask.then(() => { clearTimeout(timer); resolve(true); });
    });
  }

  close() {
    if (!this.closeTask) {
      const previousError = this.terminal;
      this.closing = true;
      this.closeTask = this.shutdown(previousError);
    }
    return this.closeTask;
  }

  async shutdown(previousError) {
    let closeError, forced = false;
    // Observe the request immediately, but await the owned process, not a reply
    // that Chromium may never deliver before closing its DevTools transport.
    const request = this.send("Browser.close").catch((error) => { closeError = error; });
    try {
      if (!await this.waitForExit(this.closeTimeoutMs)) {
        forced = true;
        this.proc.kill("SIGKILL");
        if (!await this.waitForExit(this.killTimeoutMs)) throw new Error("browser did not exit after shutdown fallback");
      }
      this.disconnect(disconnected("browser closed"));
      await request;
      if (previousError) throw previousError;
      if (this.processError) throw this.processError;
      if (closeError && closeError.code !== "CDP_DISCONNECTED") throw closeError;
      if (this.exit.code !== 0 && !(forced && this.exit.signal === "SIGKILL")) {
        throw new Error(`browser shutdown failed (${this.exit.code ?? this.exit.signal})`);
      }
    } finally {
      this.disconnect(disconnected("browser closed"));
      this.ws?.close();
    }
  }
}

// install the Runtime.exceptionThrown collector on a connected page: the
// returned array fills with uncaught page errors — assert it empty at the
// end of the suite (declared-but-never-populated arrays cannot fail)
async function collectPageErrors(page) {
  const pageErrors = [];
  await page.send("Runtime.enable");
  const orig = page.ws.onmessage;
  page.ws.onmessage = (ev) => {
    orig(ev);
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      pageErrors.push(String(d.exception?.description ?? d.text).split("\n")[0]);
    }
  };
  return pageErrors;
}

module.exports = { CDP, sleep, collectPageErrors };
