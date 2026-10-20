// A real fresh engine, no seeded sources. Also used against the candidate ELF.
const { CDP, sleep, collectPageErrors } = require('./cdp.cjs');
const fs = require('node:fs');
const ENGINE = process.env.E2E_ENGINE ?? 'http://127.0.0.1:18263';
const KZ = `(await import('/store/instance.js')).appStore`;
let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!ok) failures++;
}

(async () => {
  const page = await CDP.launch(9336, { windowSize: '1600,1200' });
  const errors = await collectPageErrors(page);
  try {
    const collections = await (await fetch(ENGINE + '/api/collections')).json();
    check('fresh collections are empty', JSON.stringify(collections) === '{}', JSON.stringify(collections));
    await page.goto(ENGINE + '/');
    await page.poll(`!!document.querySelector('.feed-empty button')`, 20000);
    await sleep(Number(process.env.E2E_FRESH_WAIT_MS ?? 0));
    for (const [width, height] of [[1600, 1100], [1000, 800]]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await sleep(100);
      const geometry = await page.evaluate(`(() => {
        const box = el => { const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; };
        const feed=box(document.querySelector('#candidatesCol')), message=box(document.querySelector('.feed-empty p'));
        return {feed,message,dx:Math.abs(feed.x+feed.w/2-message.x-message.w/2),dy:Math.abs(feed.y+feed.h/2-message.y-message.h/2),
          text:document.querySelector('.feed-empty').textContent,errors:document.querySelectorAll('#statusStack .statuschip.error').length,
          dialogs:document.querySelectorAll('[role="dialog"],dialog[open]').length};
      })()`);
      check(`empty message centered in feed at ${width}×${height}`, geometry.dx < 1 && geometry.dy < 1,
        JSON.stringify(geometry));
      check('empty wording inline without a dialog or errors', geometry.text === 'No sources yet — add a ComfyUI host or folder' && !geometry.dialogs && !geometry.errors);
    }
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
    await sleep(100);
    if (process.env.E2E_SCREENSHOT) {
      const shot = await page.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.env.E2E_SCREENSHOT, Buffer.from(shot.data, 'base64'));
    }
    await page.clickAt('.feed-empty button');
    await page.poll(`!document.querySelector('#hostDrop').hidden && document.querySelector('#hostName').getBoundingClientRect().height > 0`);
    check('empty action opens the existing add-source form', await page.evaluate(`document.querySelectorAll('#hostName').length===1 && document.querySelectorAll('#hostAddr').length===1 && document.querySelectorAll('#hostAdd').length===1`));
    await page.clickAt('#workspace');
    await page.poll(`document.querySelector('#hostDrop').hidden`);
    check('fresh page has zero error status lines', await page.evaluate(`document.querySelectorAll('#statusStack .statuschip.error').length===0`));
    check('fresh page has no uncaught exceptions', errors.length === 0, errors.join('; '));
  } catch (error) {
    console.error('Fresh-install probe failed:', error);
    console.error('Page exceptions:', errors);
    console.error('Source control:', await page.evaluate(`({open:document.querySelector('#hostDrop')?.hidden, button:document.querySelector('.feed-empty button')?.outerHTML})`));
    throw error;
  } finally { await page.close(); }
  console.log(`\n${failures} FAIL`);
  process.exitCode = failures ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
