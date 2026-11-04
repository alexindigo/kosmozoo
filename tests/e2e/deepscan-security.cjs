const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const { CDP } = require("./cdp.cjs");
const ENGINE = process.env.E2E_ENGINE;
const directory = process.env.E2E_SECURITY_DIR;

(async () => {
  assert(ENGINE && directory, "Set E2E_ENGINE and E2E_SECURITY_DIR to the stack's mutable folder");
  const path = directory + "/deepscan.svg";
  const attacker = http.createServer((_req, res) => { res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><title>Foreign origin</title>"); });
  let page;
  let ownsFixture = false;
  try {
    const fixture = fs.openSync(path, "wx");
    ownsFixture = true;
    try {
      fs.writeFileSync(fixture, `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="32">
    <script>globalThis.deepscanExecuted=true;fetch('/api/settings/core.deepscan-svg',{method:'PATCH',headers:{'Content-Type':'application/json'},body:'{"executed":true}'})</script>
    <rect width="48" height="32" fill="red"/></svg>`);
    } finally { fs.closeSync(fixture); }
    await new Promise((resolve, reject) => { attacker.once("error", reject); attacker.listen(19163, "127.0.0.1", resolve); });
    page = await CDP.launch(19164);
    const entry = ENGINE + "/api/collections/mut/entries/deepscan.svg/bytes";
    const response = await fetch(entry);
    assert.equal(response.status, 200);
    const hash = response.headers.get("ETag").replaceAll('"', "");
    const urls = [entry, ENGINE + "/api/content/" + hash + "/bytes",
      ENGINE + "/api/features/variations/folder-image?path=" + encodeURIComponent(path)];
    for (const url of urls) {
      const raw = await fetch(url);
      assert.equal(raw.headers.get("Content-Security-Policy"), "sandbox");
      assert.equal(raw.headers.get("X-Content-Type-Options"), "nosniff");
      await raw.arrayBuffer();
      await page.goto(url);
      await page.poll("document.documentElement.localName === 'svg' && document.readyState === 'complete'");
      assert.equal(await page.evaluate("globalThis.deepscanExecuted === undefined"), true);
      assert.deepEqual(await (await fetch(ENGINE + "/api/settings/core.deepscan-svg")).json(), {});
      console.log("ok direct SVG is a loaded inert document: " + new URL(url).pathname);
    }
    await page.goto(ENGINE + "/");
    for (const url of urls) {
      const size = await page.evaluate(`new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve([image.naturalWidth,image.naturalHeight]);image.onerror=()=>reject(new Error('image failed'));image.src=${JSON.stringify(url)};document.body.appendChild(image)})`);
      assert.deepEqual(size, [48, 32]);
      console.log("ok sandboxed SVG still decodes as an image: " + new URL(url).pathname);
    }
    const saved = await page.evaluate(`(async()=>{const {api}=await import('/js/api.mjs');await api.setSettings('core.deepscan-browser',{saved:true});return await api.settings('core.deepscan-browser')})()`);
    assert.deepEqual(saved, { saved: true });
    console.log("ok same-origin app JSON transport persists settings");
    const before = await (await fetch(ENGINE + "/api/prefetch")).json();
    await page.goto("http://127.0.0.1:19163/");
    const attack = JSON.stringify({ paused: !before.paused });
    await page.evaluate(`fetch(${JSON.stringify(ENGINE + "/api/prefetch")},{method:'POST',mode:'no-cors',headers:{'Content-Type':'text/plain'},body:${JSON.stringify(attack)}}).catch(()=>null)`);
    assert.equal((await (await fetch(ENGINE + "/api/prefetch")).json()).paused, before.paused);
    const rejected = await fetch(ENGINE + "/api/prefetch", { method: "POST", headers: { Origin: "http://127.0.0.1:19163", "Content-Type": "text/plain" }, body: attack });
    assert.equal(rejected.status, 403); await rejected.arrayBuffer();
    assert.deepEqual(await (await fetch(ENGINE + "/api/settings/core.deepscan-browser")).json(), { saved: true });
    console.log("ok foreign browser-simple mutation rejected; same-origin saved settings retained");
  } finally {
    try { await page?.close(); }
    finally {
      try {
        if (attacker.listening) await new Promise((resolve, reject) => attacker.close(error => error ? reject(error) : resolve()));
      } finally { if (ownsFixture) fs.rmSync(path, { force: true }); }
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
