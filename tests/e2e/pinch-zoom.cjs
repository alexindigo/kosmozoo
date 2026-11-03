const { CDP, collectPageErrors, sleep } = require('./cdp.cjs');
const { workPath } = require('./paths.cjs');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const ENGINE = process.env.E2E_ENGINE || 'http://127.0.0.1:18260';
const FAKE = process.env.E2E_FAKE || 'http://127.0.0.1:18261';
const KZ = `(await import('/store/instance.js')).appStore`;
const out = workPath('artifacts', process.env.PINCH_EVIDENCE || 'pinch-zoom');
const failures = [], results = [];
const card = name => `.card[data-name="${name}"]`;
(async () => {
  fs.mkdirSync(out, { recursive: true });
  assert((await fetch(FAKE + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publish: [
    { name: 'zoom-tall.png', fixture: 'bulk', width: 400, height: 700, mtime: 2100004004 },
    { name: 'zoom-wide.png', fixture: 'bulk', width: 1000, height: 240, mtime: 2100004003 },
    { name: 'zoom-square.png', fixture: 'bulk', width: 500, height: 500, mtime: 2100004002 },
    { name: 'zoom-playback.webm', fixture: 'media/workflow.webm', mtime: 2100004001 },
  ] }) })).ok);
  const page = await CDP.launch(9347, { windowSize: '1440,1200' });
  const errors = await collectPageErrors(page);
  const state = () => page.evaluate(`(() => {const col=document.querySelector('#candidatesCol'),el=document.querySelector(subject+' img,'+subject+' video'),m=new DOMMatrix(getComputedStyle(el).transform);return {t:performance.now(),top:col.scrollTop,scale:m.a}})()`);
  async function reset(name = 'zoom-wide.png', offset = 0) {
    await page.evaluate(`(async()=>{const s=${KZ};window.subject=${JSON.stringify(card(name))};const i=s.state.images.findIndex(x=>x.filename===${JSON.stringify(name)});s.actions.views.set(s.state.images[i].id,null,{persist:false});s.actions.feed.restoreToIndex(i)})()`);
    await page.poll(`!!document.querySelector(${JSON.stringify(card(name) + ' .ic-loaded')})`);
    await page.evaluate(`document.querySelector(subject).scrollIntoView({block:'start'});`);
    await sleep(400);
    await page.evaluate(`document.querySelector(subject).scrollIntoView({block:'start'});document.querySelector('#candidatesCol').scrollTop+=${offset};`);
    await sleep(650);
    assert.equal((await state()).scale, 1, 'reset crop is identity');
    await page.evaluate(`window.trace=[]`);
  }
  async function point(where) {
    return page.evaluate(`(()=>{const c=document.querySelector(subject),b=c.querySelector('.media-box').getBoundingClientRect(),r=c.querySelector('img,video').getBoundingClientRect();let x=r.left+r.width/2,y=r.top+r.height/2;if(${JSON.stringify(where)}==='top')y=r.top+4;if(${JSON.stringify(where)}==='bottom')y=r.bottom-4;if(${JSON.stringify(where)}==='box'){x=b.left+4;y=b.top+4}if(${JSON.stringify(where)}==='overlay'){const p=c.querySelector('.media-play').getBoundingClientRect();x=p.left+p.width/2;y=p.top+p.height/2}if(${JSON.stringify(where)}==='foot'){const p=c.querySelector('.ctitle').getBoundingClientRect();x=p.left+150;y=p.top+p.height/2}return{x,y,hit:document.elementFromPoint(x,y)?.tagName}})()`);
  }
  async function wheel(p, dy, ctrl = false, wait = 30) {
    await page.mouse('mouseWheel', p.x, p.y, { deltaY: dy, modifiers: ctrl ? 2 : 0 });
    await sleep(wait);
  }
  async function trial(label, fn) {
    try { await fn(); console.log('ok', label); }
    catch (e) { failures.push(label + ': ' + e.message); console.error('FAIL', label, e.message); }
    const result = { label, end: await state(), trace: await page.evaluate('trace') };
    results.push(result); fs.writeFileSync(out + '/timelines.json', JSON.stringify(results, null, 2));
  }
  try {
    await page.goto(ENGINE + '/#fake#zoom-wide.png');
    await page.poll(`!!document.querySelector('.card .ic-loaded')`, 20000);
    await page.evaluate(`window.subject=${JSON.stringify(card('zoom-wide.png'))};window.trace=[];const sample=()=>{const el=document.querySelector(subject+' img,'+subject+' video');return{t:performance.now(),top:document.querySelector('#candidatesCol').scrollTop,scale:el?new DOMMatrix(getComputedStyle(el).transform).a:null}};window.addEventListener('wheel',e=>{const row={kind:'wheel',ctrl:e.ctrlKey,dy:e.deltaY,...sample()};trace.push(row);setTimeout(()=>{row.prevented=e.defaultPrevented;row.after=sample()},0)},{capture:true,passive:true});document.querySelector('#candidatesCol').addEventListener('scroll',()=>trace.push({kind:'scroll',...sample()}));`);
    for (const edge of ['top', 'bottom']) await trial('a edge ' + edge, async () => {
      await reset(); const p = await point(edge), before = await state(), d = edge === 'top' ? -8 : 8;
      if (edge === 'bottom') {
        const shot = await page.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out + '/before-edge-pinch.png', Buffer.from(shot.data, 'base64'));
      }
      await wheel(p, d); await wheel(p, d); await wheel(p, -20, true); await sleep(400);
      const after = await state(); assert(after.scale > 1.1, 'image zooms'); assert.equal(after.top, before.top, 'feed stays fixed');
      if (edge === 'bottom') {
        const shot = await page.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out + '/edge-pinch.png', Buffer.from(shot.data, 'base64'));
        const clip = await page.evaluate(`(()=>{const r=document.querySelector(subject+' .media-box').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,scale:2}})()`);
        const crop = await page.send('Page.captureScreenshot', { format: 'png', clip }); fs.writeFileSync(out + '/edge-pinch-detail.png', Buffer.from(crop.data, 'base64'));
        for (const [region, selector] of [['header','#chrome'],['rail','#feedRail'],['foot','.card.current .card-foot'],['details','#workspace'],['status','#statusCol'],['next-card','.card.current + .card']]) {
          const clip = await page.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();return r?{x:Math.max(0,r.x),y:Math.max(0,r.y),width:Math.min(innerWidth,r.right)-Math.max(0,r.x),height:Math.min(innerHeight,r.bottom)-Math.max(0,r.y),scale:2}:null})()`);
          if (clip?.width > 0 && clip?.height > 0) { const shot = await page.send('Page.captureScreenshot',{format:'png',clip}); fs.writeFileSync(out + '/review-' + region + '.png',Buffer.from(shot.data,'base64')); }
        }
      }
    });
    await trial('b letterbox', async () => { await reset(); const before = await state(); await wheel(await point('box'), -20, true); assert((await state()).scale > 1.1); assert.equal((await state()).top, before.top); });
    await trial('c play overlay and click', async () => {
      await reset('zoom-playback.webm');
      // Chromium initially hit-tests its untransformed video above the sibling
      // play overlay. The first tiny pinch creates its transform layer; the
      // next event must actually hit the overlay (the investigation's chain).
      await wheel(await point('overlay'), -2, true);
      let p = await point('overlay');
      await page.mouse('mouseMoved', p.x, p.y); await sleep(200);
      p = await point('overlay'); const before = await state();
      assert.notEqual(p.hit, 'VIDEO'); await wheel(p, -20, true); assert((await state()).scale > before.scale * 1.1); assert.equal((await state()).top, before.top);
      await page.clickAt(subjectSelector(' .media-play')); await page.poll(`!document.querySelector(subject+' video').paused && document.querySelector(subject+' video').currentTime>0`);
      await page.evaluate(`document.querySelector(subject+' video').pause()`);
    });
    for (const d of [12, 30, 80]) await trial('d ordinary ' + d, async () => {
      await reset(); const p = await point('center'), before = await state(); await wheel(p, d, false, 0);
      await page.poll(`document.querySelector('#candidatesCol').scrollTop===${before.top + d}`, 500, 5);
      const after = await state(), trace = await page.evaluate('trace');
      const first = trace.find(r => r.kind === 'wheel'); assert(after.t - first.t < 155, `release took ${after.t - first.t}ms`);
      await sleep(300); assert.equal((await state()).top, before.top + d); assert.equal((await state()).scale, 1);
    });
    await trial('e continuous then rest', async () => {
      await reset(); const p = await point('center'); await wheel(p, 50); await wheel(p, 12); await wheel(p, 12);
      let rows = await page.evaluate(`trace.filter(r=>r.kind==='wheel')`); assert.deepEqual(rows.map(r => r.prevented), [true, false, false]);
      await sleep(400); await wheel(await point('center'), 8); rows = await page.evaluate(`trace.filter(r=>r.kind==='wheel')`); assert.equal(rows.at(-1).prevented, true);
      await wheel(await point('center'), -20, true);
    });
    await trial('f no tidy after pinch near boundary', async () => {
      await reset('zoom-square.png', -120);
      const p = await point('center'), before = await state(); await wheel(p, 30); await wheel(p, 30); await wheel(p, -20, true);
      const pinched = await state(); await sleep(600); assert((await state()).scale > 1.1); assert.equal((await state()).top, pinched.top, 'no later tidy'); assert.equal(pinched.top, before.top + 60);
    });
    await trial('f pending native settle is retired', async () => {
      await reset('zoom-square.png', -170);
      const p = await point('center'), before = await state();
      await wheel(p, 50); await wheel(p, 30); await wheel(p, 30); await wheel(p, -20, true);
      const pinched = await state(); await sleep(600);
      assert.equal(pinched.top, before.top + 110); assert.equal((await state()).top, pinched.top, 'native gesture cannot tidy after pinch');
      assert((await state()).scale > 1.1);
    });
    await trial('f in-flight smooth motion stops at pinch', async () => {
      await reset(); const before = await state();
      await page.evaluate(`(async()=>${KZ}.actions.feed.scrollTop())()`); await sleep(45);
      const moving = await state(); assert(moving.top < before.top && moving.top > 0, 'smooth motion actually started');
      const p = await point('center'); await wheel(p, -20, true);
      const stopped = await state(); await sleep(500);
      assert((await state()).scale > 1.1, 'recognised pinch zooms visible media');
      assert.equal((await state()).top, stopped.top, 'in-flight motion stays stopped');
      assert(stopped.top > 0, 'pinch does not finish the older top intent');
    });
    await trial('g nonmedia and rail', async () => {
      await reset(); const before = await state(); await wheel(await point('foot'), 12); await page.poll(`document.querySelector('#candidatesCol').scrollTop===${before.top + 12}`);
      assert.equal((await page.evaluate(`trace.filter(r=>r.kind==='wheel')`))[0].prevented, false);
      const rail = await page.evaluate(`(()=>{const r=document.querySelector('#feedRail').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`), top = (await state()).top;
      await wheel(rail, 50); await sleep(200); assert.equal((await state()).top, top); assert.equal((await page.evaluate(`trace.filter(r=>r.kind==='wheel')`)).at(-1).prevented, true);
    });
    assert.deepEqual(errors, []); assert.deepEqual(failures, []);
    console.log('PASS pinch-zoom (12 browser contracts, no page errors)');
  } finally { await page.close(); }
  function subjectSelector(suffix) { return card('zoom-playback.webm') + suffix; }
})().catch(e => { console.error(e); process.exitCode = 1; });
