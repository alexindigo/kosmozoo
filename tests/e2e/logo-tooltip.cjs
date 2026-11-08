// Consumer regression: a runtime outage must recover without replacing user work.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CDP, collectPageErrors, sleep } = require('./cdp.cjs');
const { workPath } = require('./paths.cjs');
const ENGINE = process.env.E2E_ENGINE || 'http://127.0.0.1:18260';
const KZ = `(await import('/store/instance.js')).appStore`;
const titles = `['#chrome img.logo','#chrome h1'].map(s=>document.querySelector(s)?.getAttribute('title'))`;
const known = 'Kosmozoo v0.4.0 (0123456)';

(async () => {
  const page = await CDP.launch(9351, { windowSize: '1440,1000' });
  const errors = await collectPageErrors(page), failures = [];
  const checkTitles = async (expected, phase) => {
    const actual = await page.evaluate(titles);
    console.log(phase, JSON.stringify(actual));
    if (JSON.stringify(actual) !== JSON.stringify([expected, expected])) failures.push(`${phase}: ${JSON.stringify(actual)}`);
  };
  const shot = async (name, clip) => {
    fs.mkdirSync(workPath('artifacts'), { recursive: true });
    const image = await page.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) });
    fs.writeFileSync(workPath(`artifacts/${name}.png`), Buffer.from(image.data, 'base64'));
  };
  try {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{
      const original=window.fetch;window.__identityCalls=0;window.__identityMode='held';
      window.fetch=(url,options)=>{
        if(String(url)!=='/api/runtime')return original(url,options);
        window.__identityCalls++;
        const respond=()=>new Response(JSON.stringify(window.__identityMode==='failed'?{error:'controlled outage'}:
          {app:{version:'0.4.0',revision:window.__identityMode==='dev'?null:'0123456789abcdef'}}),
          {status:window.__identityMode==='failed'?503:200,headers:{'Content-Type':'application/json'}});
        if(window.__identityMode==='held')return new Promise(resolve=>window.__identityRelease=()=>resolve(respond()));
        return Promise.resolve(respond());
      };
    })()` });
    await page.goto(ENGINE + '/#fake#flux-basic.png');
    await page.poll(`!!document.querySelector('#chrome h1') && window.__identityCalls===1`);
    await checkTitles('Kosmozoo', 'pending fallback');
    // A pending identity must not hold inventory/settings boot hostage.
    try { await page.poll(`!!document.querySelector('.card textarea.pos')`, 4000); }
    catch { failures.push('pending identity blocked feed boot'); }
    await page.evaluate(`window.__identityMode='failed';window.__identityRelease()`);
    await page.poll(`!!document.querySelector('.card[data-name="flux-basic.png"] textarea.pos')`, 15000);
    await checkTitles('Kosmozoo', 'unavailable fallback');
    await page.evaluate(`(async()=>{const s=${KZ};s.handles.invoke('selection.set',{id:'fake:flux-basic.png',value:true});
      window.__identityDocument=document;window.__identityCard=document.querySelector('.card[data-name="flux-basic.png"]');
      window.__identityEditor=window.__identityCard.querySelector('textarea.pos');
      window.__identityEditor.focus();window.__identityEditor.select();
      const {api}=await import('/js/api.mjs');window.__identityWriter=api.setJudgment;
      api.setJudgment=()=>new Promise(resolve=>window.__identitySave=resolve);
    })()`);
    await page.send('Input.insertText', { text: 'tooltip recovery draft' });
    const snapshot = ` (async()=>{const s=${KZ};return {sameDocument:document===window.__identityDocument,
      sameCard:document.querySelector('.card[data-name="flux-basic.png"]')===window.__identityCard,
      sameEditor:window.__identityCard.querySelector('textarea.pos')===window.__identityEditor,
      note:window.__identityEditor.value,draft:s.state.drafts['fake:flux-basic.png:pos'],
      selected:!!s.state.selected['fake:flux-basic.png'],url:location.href,current:s.state.current()}})()`;
    const before = await page.evaluate(snapshot);
    assert.equal(before.note, 'tooltip recovery draft'); assert.equal(before.selected, true);
    await page.evaluate(`window.__identityMode='known'`);
    try { await page.poll(`document.querySelector('#chrome h1')?.title===${JSON.stringify(known)}`, 6000); }
    catch { failures.push('failed read did not recover automatically'); }
    await checkTitles(known, 'recovered known identity');
    assert.deepEqual(await page.evaluate(snapshot), before, 'recovery retains document, card, editor, draft, selection, URL and current');
    assert.deepEqual(failures, [], failures.join('; '));
    assert(await page.evaluate(`window.__identityCalls>=2`), 'recovery issued another read');
    const geometry = await page.evaluate(`['#chrome img.logo','#chrome h1','#refreshBtn'].map(s=>document.querySelector(s).getBoundingClientRect().toJSON())`);
    // Suspension/resumption refreshes through the same owner, retaining last good.
    await page.evaluate(`window.__identityMode='failed';window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))`);
    await sleep(100);
    await checkTitles(known, 'last good after resumed failure');
    await page.evaluate(`window.__identityMode='dev'`);
    await page.poll(`document.querySelector('#chrome h1')?.title==='Kosmozoo v0.4.0-dev'`, 6000);
    await checkTitles('Kosmozoo v0.4.0-dev', 'honest no-revision identity');
    assert.deepEqual(await page.evaluate(snapshot), before);
    assert.deepEqual(await page.evaluate(`['#chrome img.logo','#chrome h1','#refreshBtn'].map(s=>document.querySelector(s).getBoundingClientRect().toJSON())`), geometry, 'title changes do not move header');
    await page.evaluate(`window.__identityMode='known';window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))`);
    await page.poll(`document.querySelector('#chrome h1')?.title===${JSON.stringify(known)}`);
    const box = await page.evaluate(`document.querySelector('#chrome h1').getBoundingClientRect().toJSON()`);
    await page.mouse('mouseMoved', box.x + box.width / 2, box.y + box.height / 2);
    await sleep(1500);
    await shot('logo-tooltip-full');
    await shot('logo-tooltip-header-hover', { x: 0, y: 0, width: 600, height: 180, scale: 2 });
    assert.deepEqual(failures, []);
    assert.deepEqual(errors, []);
    console.log('ok identical native titles; pending/failure fallback; automatic recovery; last-good; dev identity; retained work; stable geometry; no reload');
    console.log('Hover was dispatched; DOM titles and screenshots do not alone prove native tooltip popup paint.');
  } finally { await page.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
