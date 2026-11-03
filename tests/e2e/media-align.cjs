// The shared surface inset is observable at the media consumer, not a CSS value.
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { workPath } = require('./paths.cjs');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const ENGINE = process.env.E2E_ENGINE || 'http://127.0.0.1:18260';
const FAKE = process.env.E2E_FAKE || 'http://127.0.0.1:18261';
const KZ = `(await import('/store/instance.js')).appStore`;
const out = workPath('artifacts', process.env.ALIGN_EVIDENCE || 'media-align');
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const page = await CDP.launch(9352, { windowSize: '1440,1000' });
  const errors = await collectPageErrors(page), failures = [], measurements = [];
  const check = (label, ok, detail) => { console.log(`${ok ? 'ok' : 'FAIL'} ${label}`, JSON.stringify(detail)); if (!ok) failures.push(label); };
  const name = 'media-align-square.png';
  const input = `media-align-input-${Date.now()}.png`;
  try {
    await page.goto(ENGINE + '/#fake#flux-basic.png');
    await page.poll(`!!document.querySelector('.card .ic-loaded')`, 20000);
    await page.evaluate(`(async()=>{
      const blob=new Blob([Uint8Array.from(atob('${fs.readFileSync(workPath('tests/fixtures/media/square.png')).toString('base64')}'),c=>c.charCodeAt(0))],{type:'image/png'});
      const f=new FormData(); f.set('image',new File([blob],'${input}',{type:'image/png'}));
      const r=await fetch('/api/collections/fake/entries',{method:'POST',body:f});if(!r.ok)throw Error('upload '+r.status);
    })()`);
    const graph = { '1': { class_type: 'LoadImage', inputs: { image: input } }, '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'media-align' } } };
    assert((await fetch(FAKE + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publish: [{ name, fixture: 'media/square.png', graph, mtime: 2100008000 }] }) })).ok);
    for (const width of [1400, 1000]) for (const layout of ['split', 'rev']) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await page.evaluate(`(async()=>{const s=${KZ};await s.actions.ui.setWorkspace('details');await s.actions.anchors.setPaneWidth(${width === 1400 ? 600 : 450});await s.actions.ui.setInfoLayout('${layout}');await s.actions.ui.setFilter('media-align-square');await s.actions.ui.refresh();await fetch('/api/collections/fake/entries/${name}/bytes');await s.actions.ui.refresh();await s.handles.invoke('entry.select',{source:'fake',file:'${name}'});await s.handles.invoke('feed.revealEntry',{id:'fake:${name}'});s.state.feedScrollEl().scrollTop=0})()`);
      await page.poll(`document.querySelector('.card.current .ic-loaded') && document.querySelector('#workspace .info-source-images .ic-loaded')`, 20000);
      await page.evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
      const result = await page.evaluate(`(async()=>{
        const s=${KZ}, card=document.querySelector('.card.current'), pane=document.querySelector('#workspace'), box=card.querySelector('.media-box'), peer=pane.querySelector('.media-box');
        const r=e=>{const b=e.getBoundingClientRect(),c=getComputedStyle(e);return{tag:e.id||e.className,top:b.top,height:b.height,border:parseFloat(c.borderTopWidth),padding:parseFloat(c.paddingTop),margin:parseFloat(c.marginTop)}};
        const chain=e=>{const a=[];for(;e&&e.id!=='main';e=e.parentElement)a.push(r(e));return a.reverse()};
        const {cardHeight,gridGapPx}=await import('/store/sizes.js'),expected=cardHeight(s.state.cardSize(Number(card.dataset.idx)),s.state.feedScrollEl().clientWidth),item=s.state.feedVirtualizer().getVirtualItems().find(x=>x.key===s.state.currentEntry().entry.id);
        return{card:chain(box.querySelector('img')),details:chain(peer.querySelector('img')),delta:box.getBoundingClientRect().top-peer.getBoundingClientRect().top,cardHeight:card.getBoundingClientRect().height,expected,stride:item?.size,gap:gridGapPx(),head:r(pane.querySelector('.ws-head'))};
      })()`);
      measurements.push({ width, layout, ...result });
      fs.writeFileSync(out + '/chains.json', JSON.stringify(measurements, null, 2));
      check(`${width} ${layout}: media tops align within half a pixel`, Math.abs(result.delta) <= .5, { delta: result.delta });
      check(`${width} ${layout}: card height and virtual stride stay exact`, result.cardHeight === result.expected && result.stride === result.expected + result.gap, { height: result.cardHeight, expected: result.expected, stride: result.stride, gap: result.gap });
      const shot = await page.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(`${out}/${width}-${layout}.png`, Buffer.from(shot.data, 'base64'));
      if (width === 1400 && layout === 'split') {
        const crop = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 45, width: 1400, height: 160, scale: 2 } });
        fs.writeFileSync(out + '/image-tops.png', Buffer.from(crop.data, 'base64'));
      }
    }
    await page.evaluate(`(async()=>{
      const s=${KZ},b=new Blob([Uint8Array.from(atob('${fs.readFileSync(workPath('tests/fixtures/media/square.png')).toString('base64')}'),c=>c.charCodeAt(0))],{type:'image/png'});
      await s.handles.invoke('anchor.add',{files:[new File([b],'media-align-anchor.png',{type:'image/png'})]});
      await s.actions.ui.setWorkspace('anchors');
    })()`);
    await page.poll(`!!document.querySelector('.anchor .ic-loaded')`, 20000);
    const anchor = await page.evaluate(`(()=>{
      const c=document.querySelector('.card.current'),a=document.querySelector('.card.anchor'),w=document.querySelector('#workspace');
      return {feed:c.querySelector('.media-box').getBoundingClientRect().top,anchor:a.querySelector('.media-box').getBoundingClientRect().top,
        feedBorder:getComputedStyle(c).borderTopWidth,anchorBorder:getComputedStyle(a).borderTopWidth,workspaceBorder:getComputedStyle(w).borderTopWidth};
    })()`);
    check('Anchors: card owns its full frame and shares the feed media top', Math.abs(anchor.feed-anchor.anchor)<=.5 && anchor.feedBorder==='1px' && anchor.anchorBorder==='1px' && anchor.workspaceBorder==='0px', anchor);
    const anchorShot = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(out + '/anchors.png', Buffer.from(anchorShot.data, 'base64'));
    await page.evaluate(`(async()=>${KZ}.actions.ui.setWorkspace('details'))()`);
    await page.poll(`!!document.querySelector('#workspace .info-source-images .ic-loaded')`, 20000);
    const restored = await page.evaluate(`(()=>{const w=document.querySelector('#workspace');return {border:getComputedStyle(w).borderTopWidth,delta:document.querySelector('.card.current .media-box').getBoundingClientRect().top-w.querySelector('.media-box').getBoundingClientRect().top}})()`);
    check('Details: returning from Anchors restores the single frame and alignment', restored.border==='1px' && Math.abs(restored.delta)<=.5, restored);
    assert.deepEqual(errors, [], 'no page errors');
    assert.deepEqual(failures, [], 'media alignment contract');
  } catch (e) {
    console.error('diagnostic', await page.evaluate(`(async()=>({current:${KZ}.state.current(),workspace:document.querySelector('#workspace')?.innerHTML,cards:[...document.querySelectorAll('.card')].map(c=>({name:c.dataset.name,classes:c.className,media:c.querySelector('.media-box')?.className}))}))()`));
    throw e;
  } finally { await page.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
