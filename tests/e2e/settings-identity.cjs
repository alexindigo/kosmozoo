// Consumer regression: a runtime outage must recover without replacing user work.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CDP, collectPageErrors, sleep } = require('./cdp.cjs');
const { workPath } = require('./paths.cjs');
const ENGINE = process.env.E2E_ENGINE || 'http://127.0.0.1:18260';
const KZ = `(await import('/store/instance.js')).appStore`;
const known = 'Kosmozoo v0.4.0 (0123456)';

(async () => {
  const page = await CDP.launch(9351, { windowSize: '1440,1000' });
  const errors = await collectPageErrors(page), failures = [];
  const checkIdentity = async (expected, phase) => {
    const actual = await page.evaluate(`(()=>{
      const menu=document.querySelector('#menu'),footer=document.querySelector('#menuIdentity');
      if(!footer)return {missingFooter:true};
      const box=footer.getBoundingClientRect(),bounds=menu.getBoundingClientRect();
      const range=document.createRange();range.selectNodeContents(footer);
      const text=range.getBoundingClientRect(),style=getComputedStyle(footer);
      return {text:footer.textContent,last:menu.lastElementChild===footer,
        outsideRows:!footer.closest('#menuRows'),visible:box.width>0&&box.height>0,
        contained:text.left>=bounds.left&&text.right<=bounds.right&&text.top>=bounds.top&&text.bottom<=bounds.bottom,
        singleLine:range.getClientRects().length===1&&style.whiteSpace==='nowrap',
        readOnly:!footer.matches('a,button,input,[tabindex]')&&!footer.querySelector('a,button,input,[tabindex]'),
        titles:['#chrome img.logo','#chrome h1'].map(s=>document.querySelector(s)?.getAttribute('title')),
        geometry:{menu:bounds.toJSON(),footer:box.toJSON(),text:text.toJSON()}};
    })()`);
    console.log(phase, JSON.stringify(actual));
    if(actual.text!==expected||!actual.last||!actual.outsideRows||!actual.visible||!actual.contained||
      !actual.singleLine||!actual.readOnly||JSON.stringify(actual.titles)!=='[null,null]') failures.push(phase);
  };
  const shot = async (name, clip) => {
    fs.mkdirSync(workPath('runtime/settings-identity/artifacts'), { recursive: true });
    const image = await page.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) });
    fs.writeFileSync(workPath(`runtime/settings-identity/artifacts/${name}.png`), Buffer.from(image.data, 'base64'));
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
    await page.clickAt('#menuBtn');
    await page.poll(`!!document.querySelector('#menu')`);
    await checkIdentity('Kosmozoo', 'pending fallback via real Options button');
    assert.equal(await page.evaluate('window.__identityCalls'), 1, 'opening menu does not acquire identity');
    await page.clickAt('#menuSearch');
    await page.send('Input.insertText', { text: 'no matching setting xyz' });
    await page.poll(`document.querySelector('#menuRows').children.length===0`);
    await checkIdentity('Kosmozoo', 'filtered-empty fallback');
    await page.evaluate(`document.querySelector('#menuSearch').select()`);
    await page.keyTrusted('Backspace', { vk: 8 });
    await page.clickAt('#menuBtn');
    // A pending identity must not hold inventory/settings boot hostage.
    try { await page.poll(`!!document.querySelector('.card textarea.pos')`, 4000); }
    catch { failures.push('pending identity blocked feed boot'); }
    await page.evaluate(`window.__identityMode='failed';window.__identityRelease()`);
    await page.poll(`!!document.querySelector('.card[data-name="flux-basic.png"] textarea.pos')`, 15000);
    await page.clickAt('#menuBtn');
    await checkIdentity('Kosmozoo', 'unavailable fallback');
    await page.clickAt('#menuBtn');
    await page.evaluate(`(async()=>{const s=${KZ};s.handles.invoke('selection.set',{id:'fake:flux-basic.png',value:true});
      window.__identityDocument=document;window.__identityCard=document.querySelector('.card[data-name="flux-basic.png"]');
      window.__identityEditor=window.__identityCard.querySelector('textarea.pos');
      window.__identityEditor.focus();window.__identityEditor.select();
      const {api}=await import('/js/api.mjs');window.__identityWriter=api.setJudgment;
      api.setJudgment=()=>new Promise(resolve=>window.__identitySave=resolve);
    })()`);
    await page.send('Input.insertText', { text: 'identity recovery draft' });
    const snapshot = ` (async()=>{const s=${KZ};return {sameDocument:document===window.__identityDocument,
      sameCard:document.querySelector('.card[data-name="flux-basic.png"]')===window.__identityCard,
      sameEditor:window.__identityCard.querySelector('textarea.pos')===window.__identityEditor,
      note:window.__identityEditor.value,draft:s.state.drafts['fake:flux-basic.png:pos'],
      selected:!!s.state.selected['fake:flux-basic.png'],url:location.href,current:s.state.current()}})()`;
    const before = await page.evaluate(snapshot);
    assert.equal(before.note, 'identity recovery draft'); assert.equal(before.selected, true);
    await page.clickAt('#menuBtn');
    await page.evaluate(`window.__identityMode='known'`);
    try { await page.poll(`(async()=>${KZ}.state.appVersion()==='v0.4.0 (0123456)')()`, 6000); }
    catch { failures.push('failed read did not recover automatically'); }
    await checkIdentity(known, 'recovered known identity');
    assert.deepEqual(await page.evaluate(snapshot), before, 'recovery retains document, card, editor, draft, selection, URL and current');
    assert(await page.evaluate(`window.__identityCalls>=2`), 'recovery issued another read');
    const geometry = await page.evaluate(`['#chrome img.logo','#chrome h1','#refreshBtn'].map(s=>document.querySelector(s).getBoundingClientRect().toJSON())`);
    // Suspension/resumption refreshes through the same owner, retaining last good.
    await page.evaluate(`window.__identityMode='failed';window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))`);
    await sleep(100);
    await checkIdentity(known, 'last good after resumed failure');
    await page.evaluate(`window.__identityMode='dev'`);
    await page.poll(`(async()=>${KZ}.state.appVersion()==='v0.4.0-dev')()`, 6000);
    await checkIdentity('Kosmozoo v0.4.0-dev', 'honest no-revision identity');
    assert.deepEqual(await page.evaluate(snapshot), before);
    assert.deepEqual(await page.evaluate(`['#chrome img.logo','#chrome h1','#refreshBtn'].map(s=>document.querySelector(s).getBoundingClientRect().toJSON())`), geometry, 'identity changes do not move header');
    await page.evaluate(`window.__identityMode='known';window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))`);
    await page.poll(`(async()=>${KZ}.state.appVersion()==='v0.4.0 (0123456)')()`);
    await page.clickAt('#menuSearch');
    await page.send('Input.insertText', { text: 'no matching setting xyz' });
    await page.poll(`document.querySelector('#menuRows').children.length===0`);
    await checkIdentity(known, 'filtered-empty known identity');
    await page.evaluate(`document.querySelector('#menuSearch').select()`);
    await page.keyTrusted('Backspace', { vk: 8 });
    await page.poll(`document.querySelector('#menuRows').children.length>0`);
    await checkIdentity(known, 'unfiltered footer after feature contributions');
    assert.deepEqual(failures, [], failures.join('; '));
    await shot('settings-identity-full');
    const box = await page.evaluate(`document.querySelector('#menuIdentity').getBoundingClientRect().toJSON()`);
    await shot('settings-identity-footer', { x: box.x, y: box.y, width: box.width, height: box.height, scale: 2 });
    assert.deepEqual(errors, []);
    console.log('ok visible last-child settings identity; empty filter; full-text containment; no brand titles; automatic recovery; last-good; dev identity; retained document/draft/selection; no reload');
  } finally { await page.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
