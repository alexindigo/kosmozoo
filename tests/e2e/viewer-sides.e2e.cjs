// Placement is independent of opener, subject and view. Probe real hit regions,
// including both wipe directions, rather than trusting DOM order or data labels.
const { CDP, collectPageErrors } = require('./cdp.cjs');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const ENGINE = process.env.E2E_ENGINE || 'http://127.0.0.1:18760';
const FAKE = process.env.E2E_FAKE || 'http://127.0.0.1:18761';
const KZ = `(await import('/store/instance.js')).appStore`;
let failures = 0, checks = 0;
const check = (name, ok, detail = '') => { checks++; console.log(`${ok ? 'ok' : 'FAIL'} ${name} ${detail.replace(/data:image[^"\s]+/g, 'data:image[anchor]')}`); if (!ok) failures++; };
(async () => {
  const page = await CDP.launch(9392, { windowSize: '1600,1000' });
  const errors = await collectPageErrors(page);
  const invoke = (id, args = {}) => page.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const frames = () => page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  try {
    await page.send('Emulation.setDeviceMetricsOverride', { width:1600, height:1000, deviceScaleFactor:1, mobile:false });
    await page.goto(ENGINE + '/#fake');
    await page.poll(`(async()=>${KZ}.state.images.length > 3000)()`, 20000);
    await page.evaluate(`(async()=>{const c=document.createElement('canvas');c.width=1600;c.height=1000;const x=c.getContext('2d');
      x.fillStyle='#155e75';x.fillRect(0,0,c.width,c.height);x.fillStyle='#f0f9ff';x.font='bold 48px sans-serif';
      x.fillText('B — Compare image',850,450);x.font='32px sans-serif';x.fillText('viewer-sides-input.png',850,510);
      const blob=await new Promise(r=>c.toBlob(r,'image/png')),form=new FormData();form.set('image',new File([blob],'viewer-sides-input.png',{type:'image/png'}));
      const r=await fetch('/api/collections/fake/entries',{method:'POST',body:form});if(!r.ok)throw Error('input fixture '+r.status);})()`);
    const graph = { '1':{class_type:'LoadImage',inputs:{image:'viewer-sides-input.png'}}, '2':{class_type:'SaveImage',inputs:{images:['1',0],filename_prefix:'viewer-sides'}} };
    assert((await fetch(FAKE+'/__test/activity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({publish:[{name:'viewer-sides-output.png',fixture:'bulk',width:1600,height:1000,graph,mtime:2100002000}]})})).ok);
    await page.evaluate(`(async()=>{const s=${KZ};await s.actions.ui.refresh();await fetch('/api/collections/fake/entries/viewer-sides-output.png/bytes');await s.actions.ui.refresh();
      s.actions.ui.setWorkspace('details');s.actions.ui.setInfoLayout('split');s.actions.anchors.setPaneWidth(600);s.actions.current.set('fake','viewer-sides-output.png');s.actions.feed.restoreToIndex(s.state.currentEntry().index);
      const b=await(await fetch('/api/collections/fake/entries/viewer-sides-input.png/bytes?kind=input')).blob();await s.actions.anchors.addFiles([new File([b],'sides-anchor.png',{type:'image/png'})]);})()`);
    const modes = await page.evaluate(`(async()=>(await import('/features/diff/views.mjs')).workbenchViews('image').map(v=>v.mode))()`);
    for (const opener of ['feed','metadata','anchor']) {
      await invoke('workbench.close');
      await page.evaluate(`(async()=>{const s=${KZ};s.actions.ui.setWorkspace('${opener==='anchor'?'anchors':'details'}');s.actions.current.set('fake','viewer-sides-output.png');s.actions.feed.restoreToIndex(s.state.currentEntry().index);})()`);
      const selector = opener==='feed' ? '.card[data-name="viewer-sides-output.png"] .media-box img' : opener==='metadata' ? '.infoimg[data-file="viewer-sides-input.png"] img' : '.anchor[data-name="sides-anchor.png"] img';
      await page.poll(`document.querySelector(${JSON.stringify(selector)})?.naturalWidth>0`,15000);
      await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
      await frames(); await page.clickAt(selector);
      await page.poll(`(async()=>${KZ}.state.diff.open)()`);
      const urls = await page.evaluate(`(async()=>{const s=${KZ},p=s.state.diffPair();return {a:new URL(s.actions.diff.resolve(p.a).src,location.href).href,b:new URL(s.actions.diff.resolve(p.b).src,location.href).href}})()`);
      for (const mode of modes) {
        await invoke('workbench.mode',{mode});
        for (const subject of ['a','b']) {
          // Exercise the actual keyboard dispatcher, whose direction must agree
          // with the placement contract without moving either resource.
          if (mode==='full') await invoke('workbench.column',{column:subject==='a'?'feed':'right'});
          else await page.key(subject==='a'?'ArrowLeft':'ArrowRight');
          await frames();
          const active = await page.evaluate(`(async()=>({subject:${KZ}.state.diff.subject,label:document.querySelector('#diffCtl .dz-sidebtn').textContent.trim()}))()`);
          check(`${opener}/${mode}/${subject}: subject and label`,active.subject===subject&&active.label===subject.toUpperCase(),JSON.stringify(active));
          if (mode==='two-up'||mode==='split') {
            for (const split of mode==='split'?[.25,.75]:[.5]) {
              await invoke('workbench.parameters',{parameter:'split',value:split}); await frames();
              await page.poll(`document.querySelector('.dz-a img')?.naturalWidth>0&&document.querySelector('.dz-b img')?.naturalWidth>0`);
              const region = await page.evaluate(`(()=>{const stage=document.getElementById('diffStage').getBoundingClientRect(),y=stage.top+stage.height/2;
                const visible={a:[],b:[]},pixels={a:[],b:[]};for(let x=stage.left+2;x<stage.right;x+=4){const hit=document.elementFromPoint(x,y),cell=hit?.closest('.dz-cell');const side=cell?.classList.contains('dz-a')?'a':cell?.classList.contains('dz-b')?'b':null;if(side){visible[side].push(x-stage.left);if(hit.tagName==='IMG')pixels[side].push(x-stage.left)}}
                const span=xs=>xs.length?[Math.min(...xs),Math.max(...xs)]:[],bounds=side=>{const r=document.querySelector('.dz-'+side+' img').getBoundingClientRect();return [r.left-stage.left,r.right-stage.left]};
                return {width:stage.width,a:span(visible.a),b:span(visible.b),imageA:span(pixels.a),imageB:span(pixels.b),boundsA:bounds('a'),boundsB:bounds('b'),urls:{a:document.querySelector('.dz-a img').src,b:document.querySelector('.dz-b img').src}}})()`);
              const boundary=region.width*split;
              const imageMatches=(actual,bounds,left,right)=>actual.length===2&&Math.abs(actual[0]-Math.max(bounds[0],left))<12&&Math.abs(actual[1]-Math.min(bounds[1],right))<12;
              check(`${opener}/${mode}/${subject}/${split}: A left, B right visible image regions`,region.urls.a===urls.a&&region.urls.b===urls.b&&region.a.length===2&&region.b.length===2&&region.a[0]<5&&Math.abs(region.a[1]-boundary)<12&&Math.abs(region.b[0]-boundary)<12&&region.b[1]>region.width-5&&imageMatches(region.imageA,region.boundsA,0,boundary)&&imageMatches(region.imageB,region.boundsB,boundary,region.width),JSON.stringify(region));
            }
          } else if (mode==='difference') {
            await invoke('workbench.parameters',{parameter:'opacity',value:0});
            await page.poll(`document.querySelector('.dz-canvas')?.width>0`); await frames();
            const pixel=await page.evaluate(`(()=>{const c=document.querySelector('.dz-canvas'),im=document.querySelector('.dz-${subject} img'),p=document.createElement('canvas');p.width=p.height=1;p.getContext('2d').drawImage(im,im.naturalWidth/2,im.naturalHeight/2,1,1,0,0,1,1);return {base:[...p.getContext('2d').getImageData(0,0,1,1).data],actual:[...c.getContext('2d').getImageData(c.width/2,c.height/2,1,1).data]}})()`);
            check(`${opener}/difference/${subject}: composite retains subject base`,pixel.base.every((v,i)=>Math.abs(v-pixel.actual[i])<=2),JSON.stringify(pixel));
            await invoke('workbench.parameters',{parameter:'opacity',value:1});
          } else {
            await page.poll(`document.querySelector('.dz-${subject} img')?.naturalWidth>0`);await frames();
            const visible=await page.evaluate(`(()=>{const r=document.getElementById('diffStage').getBoundingClientRect(),cell=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('.dz-cell');return cell?.querySelector('img')?.src})()`);
            check(`${opener}/${mode}/${subject}: subject URL shown without reassignment`,visible===urls[subject],visible);
          }
        }
      }
      if(opener==='metadata'&&process.env.E2E_SIDES_SHOT){await invoke('workbench.mode',{mode:'split'});await page.key('ArrowLeft');await invoke('workbench.parameters',{parameter:'split',value:.5});await frames();fs.writeFileSync(process.env.E2E_SIDES_SHOT,Buffer.from((await page.send('Page.captureScreenshot',{format:'png'})).data,'base64'));}
    }
    check('no uncaught page errors',errors.length===0,errors.join(';'));
  } finally {await page.close();}
  console.log(`viewer-sides: ${checks-failures}/${checks} checks; ${failures} failures`);
  process.exit(failures?1:0);
})().catch(e=>{console.error(e);process.exit(1)});
