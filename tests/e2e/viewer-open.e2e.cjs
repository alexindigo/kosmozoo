// Every existing image opener, every image view, and real pointer clicks in-view.
const { CDP, collectPageErrors } = require('./cdp.cjs');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const ENGINE = process.env.E2E_ENGINE || 'http://127.0.0.1:18760';
const FAKE = process.env.E2E_FAKE || 'http://127.0.0.1:18761';
const KZ = `(await import('/store/instance.js')).appStore`;
let failures = 0, checks = 0;
const check = (name, ok, detail = '') => { checks++; console.log(`${ok ? 'ok' : 'FAIL'} ${name} ${detail}`); if (!ok) failures++; };
(async () => {
  const page = await CDP.launch(9391, { windowSize: '1600,1000' });
  const errors = await collectPageErrors(page);
  const invoke = (id, args = {}) => page.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const frames = () => page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  try {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.goto(ENGINE + '/#fake');
    await page.poll(`(async()=>${KZ}.state.images.length > 3000)()`, 20000);
    // Distinct source pixels make the consumer check and screenshot discriminate
    // A from B, rather than comparing two identical flat fixture images.
    await page.evaluate(`(async()=>{const c=document.createElement('canvas');c.width=1024;c.height=768;const x=c.getContext('2d');
      x.fillStyle='#164e63';x.fillRect(0,0,c.width,c.height);
      for(let y=0;y<6;y++)for(let z=0;z<8;z++){x.fillStyle=(y+z)%2?'#155e75':'#0e7490';x.fillRect(z*128,y*128,128,128)}
      x.fillStyle='#155e75';x.fillRect(480,352,64,64); // centre probe is not on a resampled tile boundary
      x.fillStyle='#f0f9ff';x.font='bold 42px sans-serif';x.fillText('Clicked metadata image',80,320);x.font='30px sans-serif';x.fillText('viewer-open-input.png',80,380);
      const blob=await new Promise(r=>c.toBlob(r,'image/png')),form=new FormData();form.set('image',new File([blob],'viewer-open-input.png',{type:'image/png'}));
      const r=await fetch('/api/collections/fake/entries',{method:'POST',body:form});if(!r.ok)throw Error('input fixture '+r.status);
      if((await r.json()).name!=='viewer-open-input.png')throw Error('fixture collision');})()`);
    const graph = { '1': { class_type:'LoadImage', inputs:{ image:'viewer-open-input.png' } }, '2': { class_type:'SaveImage', inputs:{ images:['1',0], filename_prefix:'viewer-open' } } };
    const fixture = await fetch(FAKE + '/__test/activity', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({publish:[{name:'viewer-open-output.png',fixture:'bulk',width:1024,height:1024,graph,mtime:2100002000}]}) });
    assert(fixture.ok);
    await page.evaluate(`(async()=>{const s=${KZ}; await s.actions.ui.refresh(); await fetch('/api/collections/fake/entries/viewer-open-output.png/bytes');
      await s.actions.ui.refresh(); s.actions.ui.setWorkspace('details'); s.actions.ui.setInfoLayout('split'); s.actions.anchors.setPaneWidth(600);
      s.actions.current.set('fake','viewer-open-output.png');s.actions.feed.restoreToIndex(s.state.currentEntry().index);
      const b=await(await fetch('/api/collections/fake/entries/flux-lora.png/bytes')).blob();
      await s.actions.anchors.addFiles([new File([b],'open-anchor.png',{type:'image/png'})]);})()`);
    await page.poll(`document.querySelector('.infoimg[data-file="viewer-open-input.png"] img')?.naturalWidth > 0`, 20000);
    const modes = await page.evaluate(`(async()=>(await import('/features/diff/views.mjs')).workbenchViews('image').map(v=>v.mode))()`);
    assert.equal(modes.length, 5);
    for (const opener of ['feed', 'metadata', 'anchor', 'deep-a', 'deep-b']) {
      try {
        await invoke('workbench.close');
        if (opener.startsWith('deep')) {
          // Exercise URL adoption, not just the pair command.
          const subject = opener === 'deep-b' ? 'b' : 'a';
          await page.evaluate(`history.pushState(null,'','/diff?subject=${subject}#fake#viewer-open-output.png:input%3Afake#viewer-open-input.png')`);
          await page.evaluate(`(async()=>${KZ}.actions.route.changed())()`);
        } else {
          await page.evaluate(`(async()=>{const s=${KZ};history.replaceState(null,'','/#fake#viewer-open-output.png');
            s.actions.ui.setWorkspace(${JSON.stringify(opener === 'anchor' ? 'anchors' : 'details')});
            s.actions.current.set('fake','viewer-open-output.png');s.actions.feed.restoreToIndex(s.state.currentEntry().index);})()`);
          const selector = opener === 'feed' ? '.card[data-name="viewer-open-output.png"] .media-box img'
            : opener === 'metadata' ? '.infoimg[data-file="viewer-open-input.png"] img' : '.anchor[data-name="open-anchor.png"] img';
          await page.poll(`document.querySelector(${JSON.stringify(selector)})?.naturalWidth > 0`, 15000);
          await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
          await frames();
          await page.clickAt(selector);
        }
        await page.poll(`(async()=>${KZ}.state.diff.open)()`);
        const side = opener === 'feed' || opener === 'deep-a' ? 'a' : 'b';
        const expected = opener === 'anchor'
          ? await page.evaluate(`(async()=>${KZ}.state.anchors.find(a=>a.name==='open-anchor.png').src)()`)
          : ENGINE + (side === 'a' ? '/api/collections/fake/entries/viewer-open-output.png/bytes' : '/api/collections/fake/entries/viewer-open-input.png/bytes?kind=input');
        for (const mode of modes) {
          await invoke('workbench.mode', { mode });
          await frames();
          const selector = `.dz-${side} img`;
          const ready = await page.poll(`document.querySelector('${selector}')?.naturalWidth > 0`, 3000).then(()=>true,()=>false);
          const rendered = await page.evaluate(`(()=>{const im=document.querySelector('${selector}'),stage=document.getElementById('diffStage'),r=im?.getBoundingClientRect();
            return {src:im?.src,col:stage.dataset.col,mode:stage.dataset.mode,area:r&&r.width*r.height};})()`);
          const expectedCol = side === 'a' ? 'feed' : 'right';
          check(`${opener}/${mode}: clicked URL in active cell`, ready && rendered.src === expected && rendered.col === expectedCol && rendered.mode === mode && (mode === 'difference' || rendered.area > 0), JSON.stringify({ ...rendered, src: rendered.src?.slice(0,160) }));
          if (mode === 'difference') {
            // With mask opacity zero the canvas must paint the SUBJECT's base pixels.
            await invoke('workbench.parameters', { parameter: 'opacity', value: 0 });
            await page.poll(`document.querySelector('.dz-canvas')?.width > 0`);
            await frames();
            const pixels = await page.evaluate(`(()=>{const im=document.querySelector('${selector}'),c=document.querySelector('.dz-canvas'),p=document.createElement('canvas');p.width=p.height=1;
              p.getContext('2d').drawImage(im,im.naturalWidth/2,im.naturalHeight/2,1,1,0,0,1,1);
              return {base:[...p.getContext('2d').getImageData(0,0,1,1).data],paint:[...c.getContext('2d').getImageData(Math.floor(c.width/2),Math.floor(c.height/2),1,1).data]};})()`);
            check(`${opener}/difference: subject pixels reach canvas`, pixels.base.every((v,i)=>Math.abs(v-pixels.paint[i])<=2), JSON.stringify(pixels));
            await invoke('workbench.parameters', { parameter: 'opacity', value: 1 });
          }
          const before = await page.evaluate(`(async()=>{const d=${KZ}.state.diff;return JSON.stringify({mode:d.mode,col:d.col,subject:d.subject,views:d.views})})()`);
          const clickSelector = mode === 'difference' ? '.dz-canvas' : ready ? selector : '.dz-a img';
          // In Split the active image begins just to the right of the wipe.
          const point = await page.evaluate(`(()=>{const r=document.querySelector('${clickSelector}')?.getBoundingClientRect();return r&&{x:r.x+r.width/2+2,y:r.y+r.height/2};})()`);
          if (point) { await page.mouse('mousePressed', point.x, point.y, { button:'left',clickCount:1 }); await page.mouse('mouseReleased', point.x, point.y, { button:'left',clickCount:1 }); }
          await frames();
          const after = await page.evaluate(`(async()=>{const d=${KZ}.state.diff;return JSON.stringify({mode:d.mode,col:d.col,subject:d.subject,views:d.views})})()`);
          check(`${opener}/${mode}: plain viewer click preserves session`, before === after);
          // Click-only activation (without pointer capture), e.g. an accessibility
          // click, must obey the same intent boundary as a real pointer sequence.
          if (mode !== 'difference' && ready) {
            await page.evaluate(`document.querySelector('${selector}').click()`);
            await frames();
            const clicked = await page.evaluate(`(async()=>{const d=${KZ}.state.diff;return JSON.stringify({mode:d.mode,col:d.col,subject:d.subject,views:d.views})})()`);
            check(`${opener}/${mode}: click-only activation preserves session`, before === clicked);
          }
        }
        if (opener === 'metadata' && process.env.E2E_OPEN_SHOT) {
          await invoke('workbench.mode', { mode:'full' }); await frames();
          fs.writeFileSync(process.env.E2E_OPEN_SHOT, Buffer.from((await page.send('Page.captureScreenshot', { format:'png' })).data, 'base64'));
        }
        if (opener.startsWith('deep')) {
          await page.goto(ENGINE + `/diff?subject=${side}#fake#viewer-open-output.png:input%3Afake#viewer-open-input.png`);
          const booted = await page.poll(`document.querySelector('.dz-${side} img')?.naturalWidth>0&&document.getElementById('diffStage').dataset.col==='${expectedColFor(side)}'`, 10000).then(()=>true,()=>false);
          check(`${opener}: cold URL boot displays its subject`, booted);
        }
      } catch (e) { check(opener, false, e.stack); }
    }
    check('no uncaught page errors', errors.length === 0, errors.join(';'));
  } finally { await page.close(); }
  console.log(`viewer-open: ${checks-failures}/${checks} checks; ${failures} failures`);
  process.exitCode = failures ? 1 : 0;
})().catch(e=>{console.error(e);process.exit(1)});
function expectedColFor(side) { return side === 'a' ? 'feed' : 'right'; }
