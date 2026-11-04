const assert = require('node:assert/strict');
require('./loading-harness.cjs').run(async ({ page, ENGINE }) => {
  const original = page.ws.onmessage;
  let mode = 'abort', intercepted = 0;
  page.ws.onmessage = event => {
    original(event);
    const { method, params } = JSON.parse(event.data);
    if (method !== 'Fetch.requestPaused') return;
    intercepted++;
    if (mode === 'abort') void page.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'Failed' });
    if (mode === '404') void page.send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: 404, body: '' });
  };
  try {
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/css/app.css' }] });
    for (mode of ['abort', '404', 'timeout']) {
      intercepted = 0;
      await page.goto('about:blank');
      await page.poll(`location.href === 'about:blank'`);
      await page.goto(ENGINE + '/#fake');
      await page.poll(`!!document.querySelector('#chrome') && !document.querySelector('#bootSplash')`, 10000);
      assert(intercepted > 0, 'app stylesheet was intercepted');
      assert(await page.evaluate(`(()=>{const app=document.querySelector('#app'),r=app.getBoundingClientRect();return getComputedStyle(app).display!=='none'&&getComputedStyle(app).visibility==='visible'&&r.width>0&&r.height>0})()`), 'mounted app is visible despite stylesheet failure');
      console.log('ok stylesheet ' + mode + ': splash removed and #app visible');
      await page.send('Fetch.disable');
      await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/css/app.css' }] });
    }
  } finally { page.ws.onmessage = original; }
});
