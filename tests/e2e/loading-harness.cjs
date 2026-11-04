const { CDP, collectPageErrors, sleep } = require('./cdp.cjs');
const { workPath } = require('./paths.cjs');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const ENGINE = process.env.E2E_ENGINE || 'http://127.0.0.1:18260';

exports.run = check => (async () => {
  fs.mkdirSync(workPath('artifacts'), { recursive: true });
  const page = await CDP.launch(9350, { windowSize: '1440,1000' });
  const errors = await collectPageErrors(page);
  let held = [];
  const original = page.ws.onmessage;
  page.ws.onmessage = event => {
    original(event);
    const msg = JSON.parse(event.data);
    if (msg.method === 'Fetch.requestPaused') held.push(msg.params.requestId);
  };
  const release = async () => { const ids = held; held = []; for (const requestId of ids) await page.send('Fetch.continueRequest', { requestId }); };
  const waitHeld = async () => {
    for (let i = 0; !held.length && i < 100; i++) await sleep(20);
    assert(held.length, 'expected request is held');
  };
  const shot = async (name, clip) => {
    const image = await page.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) });
    fs.writeFileSync(workPath(`artifacts/${name}.png`), Buffer.from(image.data, 'base64'));
  };
  try {
    await page.send('Network.enable');
    await page.send('Network.setCacheDisabled', { cacheDisabled: true });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await check({ page, release, waitHeld, shot, ENGINE });
    assert.deepEqual(errors, [], 'no uncaught page errors');
  } finally { await page.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
