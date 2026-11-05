const { CDP, collectPageErrors, sleep } = require('./cdp.cjs');
const { workPath } = require('./paths.cjs');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const ENGINE = process.env.E2E_ENGINE || 'http://127.0.0.1:18260';
const KZ = `(await import('/store/instance.js')).appStore`;
const warning = '#statusStack .statuschip.warning';
const text = 'Browser magnification active. Reset with Ctrl+L, Ctrl+0, Esc.';
const out = workPath('artifacts', 'native-magnification');

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const page = await CDP.launch(9357, { windowSize: '1440,1000' });
  const errors = await collectPageErrors(page), samples = [];
  const shot = async name => {
    const image = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${out}/${name}.png`, Buffer.from(image.data, 'base64'));
  };
  const sample = async label => {
    const value = await page.evaluate(`(() => {
      const el=document.querySelector(${JSON.stringify(warning)}), r=el?.getBoundingClientRect(), v=visualViewport;
      return {scale:v.scale, offset:[v.offsetLeft,v.offsetTop], viewport:[v.width,v.height],
        frame:document.querySelector('#statusViewport').getBoundingClientRect().toJSON(),
        corner:document.querySelector('#statusCol').getBoundingClientRect().toJSON(),
        chips:[...document.querySelectorAll('#statusStack .statuschip')].map(chip=>({text:chip.textContent,rect:chip.getBoundingClientRect().toJSON()})),
        rect:r?.toJSON(), count:document.querySelectorAll(${JSON.stringify(warning)}).length,
        text:el?.textContent, cursor:el && getComputedStyle(el).cursor, title:el?.getAttribute('title'),
        focus:document.activeElement?.id,
        visible:!!r && r.left>=v.offsetLeft && r.top>=v.offsetTop && r.right<=v.offsetLeft+v.width && r.bottom<=v.offsetTop+v.height};
    })()`);
    samples.push({ label, ...value });
    fs.writeFileSync(`${out}/geometry.json`, JSON.stringify(samples, null, 2));
    console.log(label, JSON.stringify(value));
    return value;
  };
  const scale = async value => {
    await page.send('Emulation.setPageScaleFactor', { pageScaleFactor: value });
    await page.poll(`Math.abs(visualViewport.scale-${value})<.001`);
  };
  async function clickWarning() {
    const s = await sample('before trusted warning click');
    assert(s.visible, 'warning must be reachable in the visual viewport before clicking');
    // Input.dispatchMouseEvent accepts viewport CSS pixels, not device pixels.
    const x = s.rect.x - s.offset[0] + s.rect.width / 2;
    const y = s.rect.y - s.offset[1] + s.rect.height / 2;
    const clicks = await page.evaluate('window.warningClicks');
    await page.mouse('mousePressed', x, y, { clickCount: 1, buttons: 1 });
    await page.mouse('mouseReleased', x, y, { clickCount: 1, buttons: 0 });
    assert.equal(await page.evaluate('window.warningClicks'), clicks + 1, 'trusted click actually hit the warning');
    assert.equal(await page.evaluate(`document.querySelectorAll(${JSON.stringify(warning)}).length`), 1);
  }
  try {
    await page.send('Network.enable');
    await page.send('Network.setCacheDisabled', { cacheDisabled: true });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    let held;
    const original = page.ws.onmessage;
    page.ws.onmessage = event => {
      original(event);
      const message = JSON.parse(event.data);
      if (message.method === 'Fetch.requestPaused') held = message.params.requestId;
    };
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/main.js' }] });
    await page.goto(ENGINE + '/#fake#flux-basic.png');
    for (let i = 0; !held && i < 100; i++) await sleep(20);
    assert(held, 'hold app load so native scale precedes observer registration');
    await scale(1.25);
    await page.send('Fetch.continueRequest', { requestId: held });
    await page.send('Fetch.disable');
    await page.poll(`!!document.querySelector(${JSON.stringify(warning)}) && !document.querySelector('#bootSplash')`, 20000);
    await page.evaluate(`window.warningClicks=0;document.addEventListener('click',e=>{if(e.isTrusted && e.target.closest(${JSON.stringify(warning)}))window.warningClicks++},true)`);
    const initial = await sample('initial native magnification');
    await shot('initial-magnified');
    assert.equal(initial.count, 1); assert.equal(initial.text, text);
    assert.equal(initial.cursor, 'default'); assert.equal(initial.title, null);
    assert(initial.visible, 'already-magnified startup warning fits actual visual viewport');
    await clickWarning();

    await scale(1);
    await page.poll(`!document.querySelector(${JSON.stringify(warning)})`);
    await page.poll(`!!document.querySelector('.card .ic-loaded')`, 20000);
    const normalCorner = await page.evaluate(`(() => {const r=document.querySelector('#statusCol').getBoundingClientRect(),f=document.querySelector('#statusViewport').getBoundingClientRect();return {right:innerWidth-r.right,bottom:innerHeight-r.bottom,frame:f.toJSON(),pointer:getComputedStyle(document.querySelector('#statusViewport')).pointerEvents}})()`);
    assert.equal(normalCorner.right, 12); assert.equal(normalCorner.bottom, 10);
    assert.equal(normalCorner.frame.x, 0); assert.equal(normalCorner.frame.y, 0);
    assert.equal(normalCorner.frame.width, 1440); assert.equal(normalCorner.frame.height, 900);
    assert.equal(normalCorner.pointer, 'none');
    assert(await page.evaluate(`!!document.elementFromPoint(20,20).closest('#chrome')`), 'viewport frame preserves underlying hit testing');
    console.log('normal status corner', JSON.stringify(normalCorner));
    const layout = `['#chrome','#candidatesCol','#workspace'].map(s=>document.querySelector(s).getBoundingClientRect().toJSON())`;
    const beforeLayout = await page.evaluate(layout);
    await page.evaluate(`document.querySelector('#refreshBtn').focus()`);
    const beforeFocus = await page.evaluate('document.activeElement.id');
    assert.equal(beforeFocus, 'refreshBtn');
    await shot('normal');
    await scale(1.25);
    await page.poll(`!!document.querySelector(${JSON.stringify(warning)})`);
    assert.deepEqual(await page.evaluate(layout), beforeLayout, 'warning changes no page layout');
    assert.equal(await page.evaluate('document.activeElement.id'), beforeFocus, 'no focus theft');
    await page.evaluate(`(async()=>{const s=${KZ};s.actions.status.info('Temporary banner companion');s.actions.status.active('banner-companion','Active banner companion');s.actions.status.error('Error banner companion')})()`);
    await page.poll(`document.querySelectorAll('#statusStack .statuschip').length>=4`);
    await page.evaluate(`visualViewport.dispatchEvent(new Event('resize'));window.dispatchEvent(new Event('pageshow'))`);
    const companions = await sample('repeated events with companion chips');
    assert.equal(companions.count, 1);
    assert(companions.chips.every(({rect}) => rect.left>=companions.offset[0] && rect.top>=companions.offset[1] && rect.right<=companions.offset[0]+companions.viewport[0] && rect.bottom<=companions.offset[1]+companions.viewport[1]), 'ordinary chips share visible-viewport framing');
    await sleep(6700);
    assert.equal(await page.evaluate(`[...document.querySelectorAll('#statusStack .statuschip')].some(e=>e.textContent==='Temporary banner companion')`), false);
    assert.equal((await sample('persists beyond six seconds')).count, 1);
    await clickWarning();
    await page.evaluate(`document.querySelector('#statusStack .statuschip.active').click();document.querySelector('#statusStack .statuschip.error').click()`);
    assert.equal(await page.evaluate(`document.querySelectorAll('#statusStack .statuschip.active,#statusStack .statuschip.error').length`), 0, 'ordinary chip dismissal retained');
    assert.equal(await page.evaluate(`document.querySelectorAll(${JSON.stringify(warning)}).length`), 1);
    await page.evaluate(`(async()=>${KZ}.actions.diff.open())()`);
    await page.poll(`!!document.querySelector('#diff:not([hidden])')`);
    const workbench = await sample('workbench magnified');
    await shot('workbench-magnified');
    assert(workbench.visible, 'warning remains visible above workbench controls');
    assert.equal(workbench.offset[1] + workbench.viewport[1] - workbench.rect.bottom, 56, 'existing workbench clearance belongs to the corner');
    await page.evaluate(`(async()=>${KZ}.actions.diff.hide())()`);

    await scale(2);
    await page.poll(`Math.abs(document.querySelector('#statusViewport').getBoundingClientRect().width-visualViewport.width)<.01`);
    // Bring offscreen chrome into view to move the actual native viewport.
    // This detector setup does not claim physical gesture/prevention coverage.
    await page.evaluate(`document.querySelector('#menuBtn').scrollIntoView({block:'center',inline:'center'})`);
    await page.poll(`visualViewport.offsetLeft>0 || visualViewport.offsetTop>0`);
    await page.poll(`Math.abs(document.querySelector('#statusViewport').getBoundingClientRect().left-visualViewport.offsetLeft)<.01 && Math.abs(document.querySelector('#statusViewport').getBoundingClientRect().top-visualViewport.offsetTop)<.01`);
    const panned = await sample('magnified with viewport pan');
    await shot('panned-magnified');
    assert(panned.offset.some(value => value > 0), 'exercise a nonzero native visual viewport offset');
    assert(panned.visible, 'warning fits the panned native visual viewport');
    await clickWarning();
    await scale(4);
    await page.poll(`Math.abs(document.querySelector('#statusViewport').getBoundingClientRect().width-visualViewport.width)<.01`);
    const narrow = await sample('narrow native visual viewport');
    assert(narrow.visible, 'all warning edges fit even when the text must wrap');
    await shot('narrow-magnified');
    await scale(1);
    await page.poll(`!document.querySelector(${JSON.stringify(warning)})`);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 2, mobile: false });
    assert.equal(await page.evaluate('visualViewport.scale'), 1);
    assert.equal(await page.evaluate(`document.querySelectorAll(${JSON.stringify(warning)}).length`), 0, 'DPR/layout-size distinction, not an actual browser-menu zoom test');
    await page.evaluate(`document.querySelector('.card[data-name="flux-basic.png"]').scrollIntoView({block:'center'})`);
    await page.evaluate(`(async()=>{const s=${KZ},id=s.state.images.find(x=>x.filename==='flux-basic.png').id;s.actions.views.set(id,{version:2,s:2,cx:.5,cy:.5,fh:false,fv:false,rot:0},{persist:false})})()`);
    await page.poll(`new DOMMatrix(getComputedStyle(document.querySelector('.card[data-name="flux-basic.png"] img')).transform).a>1`);
    assert.equal(await page.evaluate('visualViewport.scale'), 1);
    assert.equal(await page.evaluate(`document.querySelectorAll(${JSON.stringify(warning)}).length`), 0, 'ordinary image zoom alone has no warning');
    await page.send('Page.reload', { ignoreCache: true });
    await page.poll(`!!document.querySelector('.card .ic-loaded') && !document.querySelector('#bootSplash')`, 20000);
    assert.equal(await page.evaluate('visualViewport.scale'), 1);
    assert.equal(await page.evaluate(`document.querySelectorAll(${JSON.stringify(warning)}).length`), 0, 'normal-scale startup is inactive');
    assert.deepEqual(errors, []);
    console.log('PASS native-magnification: initial/live native scale, visibility/pan, persistence/clicks, coexistence/workbench, clearing, focus/layout and zoom distinction');
  } catch (error) {
    await sample('failure'); await shot('failure'); throw error;
  } finally { await page.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
