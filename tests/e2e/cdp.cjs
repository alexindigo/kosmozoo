// tests/e2e/cdp.cjs — minimal Chrome DevTools Protocol driver.
//
// Zero npm dependencies: launches the Playwright image's Chromium headless,
// talks CDP over Node 22's built-in WebSocket. Just enough for this suite:
// navigate, evaluate (awaitPromise + returnByValue), key dispatch, bounded
// polling.

const { spawn } = require("node:child_process");
const http = require("node:http");

const CHROME = process.env.CHROME_BIN
  ?? "/ms-playwright/chromium-1148/chrome-linux/chrome";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  static async launch(port = 9333) {
    const proc = spawn(CHROME, [
      "--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
      "--disable-gpu", "--hide-scrollbars", "--mute-audio",
      `--remote-debugging-port=${port}`, `--user-data-dir=/tmp/cdp-profile-${port}`,
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

  constructor(proc, wsUrl) {
    this.proc = proc;
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error("ws error"));
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
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
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
  async key(key) {
    await this.evaluate(
      `document.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true })), true`,
    );
  }

  async close() {
    try { await this.send("Browser.close"); } catch { /* already gone */ }
    try { this.proc.kill("SIGKILL"); } catch { /* fine */ }
  }
}

module.exports = { CDP, sleep };
