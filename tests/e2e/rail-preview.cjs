const { CDP, collectPageErrors, sleep } = require('./cdp.cjs');
const { workPath } = require('./paths.cjs');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const ENGINE = process.env.E2E_ENGINE || 'http://127.0.0.1:18260';
const FAKE = process.env.E2E_FAKE || 'http://127.0.0.1:18261';
const KZ = `(await import('/store/instance.js')).appStore`;
const names = {
  top: 'rail-preview-teal-top-image-with-a-long-filename-that-must-truncate.png',
  topVideo: 'rail-preview-top.webm', bottom: 'rail-preview-ochre-bottom.png', bottomVideo: 'rail-preview-bottom.webm',
  audio: 'rail-preview-audio.wav', slowA: 'rail-preview-slow-a.png', slowB: 'rail-preview-slow-b.png', failed: 'rail-preview-failed.png',
};
(async()=>{
  fs.mkdirSync(workPath('artifacts'),{recursive:true});
  const published = await fetch(FAKE+'/__test/activity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({publish:[
    {name:names.top,fixture:'bulk',width:360,height:520,color:[35,118,150,255],mtime:2100003100},
    {name:names.topVideo,fixture:'media/workflow.webm',mtime:2100003099},
    {name:names.slowA,fixture:'bulk',width:320,height:180,mtime:1799999751.8},
    {name:names.slowB,fixture:'bulk',width:320,height:180,mtime:1799999751.7},
    {name:names.failed,fixture:'bulk',width:320,height:180,mtime:1600000003},
    {name:names.bottom,fixture:'bulk',width:520,height:360,color:[184,127,68,255],mtime:1600000002},
    {name:names.audio,fixture:'media/workflow.wav',mtime:1600000001},
    {name:names.bottomVideo,fixture:'media/workflow.webm',mtime:1600000000},
  ]})});
  assert(published.ok,'preview fixtures published');
  const page=await CDP.launch(9345,{windowSize:'1440,1000'}),errors=await collectPageErrors(page);
  const timers=new Set(),active=new Set();let maximum=0;
  const original=page.ws.onmessage;
  page.ws.onmessage=event=>{
    original(event);const msg=JSON.parse(event.data),p=msg.params;
    if(msg.method==='Network.requestWillBeSent'&&/rail-preview-slow-[ab]\.png\/bytes/.test(p.request.url)){active.add(p.requestId);maximum=Math.max(maximum,active.size)}
    if(msg.method==='Network.loadingFinished'||msg.method==='Network.loadingFailed')active.delete(p.requestId);
    if(msg.method==='Fetch.requestPaused'){
      if(p.request.url.includes(names.failed))page.send('Fetch.failRequest',{requestId:p.requestId,errorReason:'Failed'}).catch(()=>{});
      else {const timer=setTimeout(()=>{timers.delete(timer);page.send('Fetch.continueRequest',{requestId:p.requestId}).catch(()=>{})},600);timers.add(timer)}
    }
  };
  const selector=name=>`.fr-tick[data-entry-id=${JSON.stringify('fake:'+name)}]`;
  const point=async name=>page.evaluate(`(()=>{const t=document.querySelector(${JSON.stringify(selector(name))}),r=t.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  const move=async name=>{const p=await point(name);await page.mouse('mouseMoved',p.x,p.y,{buttons:0});return p};
  const browse=async name=>{
    await page.mouse('mouseMoved',300,18,{buttons:0});
    const data=await page.evaluate(`(async()=>{const s=${KZ},index=s.state.entriesWithKnownSize().findIndex((_,i)=>s.state.feedEntryAt(i)?.filename===${JSON.stringify(name)}),cap=document.querySelectorAll('.fr-tick').length,start=Number(document.querySelector('.fr-top').textContent)-1,r=document.querySelector('#feedRail').getBoundingClientRect();return{index,start,next:Math.max(0,Math.min(index-2,s.state.entriesWithKnownSize().length-cap)),x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    assert(data.index>=0,`size-ready fixture ${name}`);
    if(data.next!==data.start){await page.mouse('mouseWheel',data.x,data.y,{deltaY:(data.next-data.start)*5});await page.poll(`Number(document.querySelector('.fr-top').textContent)===${data.next+1}`)}
    await page.poll(`!!document.querySelector(${JSON.stringify(selector(name))})`);
  };
  const shown=async name=>page.poll(`document.querySelector('.fr-preview')?.dataset.entryId===${JSON.stringify('fake:'+name)}`);
  const tickStyle=async name=>page.evaluate(`(()=>{const t=document.querySelector(${JSON.stringify(selector(name))}),r=t.getBoundingClientRect();return{color:getComputedStyle(t).backgroundColor,width:r.width,height:r.height,hovered:t.classList.contains('hovered')}})()`);
  const geometry=async name=>{
    const result=await page.evaluate(`(()=>{const p=document.querySelector('.fr-preview'),r=p.getBoundingClientRect(),t=document.querySelector(${JSON.stringify(selector(name))}).getBoundingClientRect(),rail=document.querySelector('#feedRail').getBoundingClientRect(),label=p.querySelector('.fr-preview-name');return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,tickCenter:(t.top+t.bottom)/2,railRight:rail.right,vw:innerWidth,vh:innerHeight,labelHeight:label.getBoundingClientRect().height,labelLine:parseFloat(getComputedStyle(label).lineHeight),labelOverflow:getComputedStyle(label).textOverflow}})()`);
    assert(result.left>=result.railRight,'preview is beside the rail');
    assert(result.left>=4&&result.right<=result.vw-4&&result.top>=4&&result.bottom<=result.vh-4,'preview stays inside viewport');
    if(result.tickCenter-result.height/2>=4&&result.tickCenter+result.height/2<=result.vh-4)assert(Math.abs(result.top+result.height/2-result.tickCenter)<0.5,'unclamped preview centers on tick');
    assert.equal(result.width,160);assert(result.labelHeight<=result.labelLine+0.5,'filename stays one line');assert.equal(result.labelOverflow,'ellipsis');
    return result;
  };
  const pixels=async expected=>{
    const result=await page.evaluate(`(()=>{const im=document.querySelector('.fr-preview img'),r=im.getBoundingClientRect(),c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');ctx.drawImage(im,0,0,1,1);return{pixel:[...ctx.getImageData(0,0,1,1).data],ratio:r.width/r.height,natural:im.naturalWidth/im.naturalHeight}})()`);
    assert.deepEqual(result.pixel,expected,'the preview renders the hovered entry actual decoded pixels');
    assert(Math.abs(result.ratio-result.natural)<0.001,'image aspect is preserved');
  };
  const capture=async name=>{
    const shot=await page.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(workPath(`artifacts/${name}.png`),Buffer.from(shot.data,'base64'));
    const clip=await page.evaluate(`(()=>{const p=document.querySelector('.fr-preview').getBoundingClientRect(),r=document.querySelector('#feedRail').getBoundingClientRect();return{x:0,y:Math.max(0,p.top-8),width:p.right+12,height:Math.min(innerHeight,p.bottom+8)-Math.max(0,p.top-8),scale:3}})()`);
    const crop=await page.send('Page.captureScreenshot',{format:'png',clip});fs.writeFileSync(workPath(`artifacts/${name}-detail.png`),Buffer.from(crop.data,'base64'));
  };
  try{
    await page.send('Network.enable');
    await page.send('Network.setCacheDisabled',{cacheDisabled:true});
    await page.goto(ENGINE+'/#fake#flux-basic.png');
    await page.poll(`!!document.querySelector('.card')`,20000);
    await page.evaluate(`(async()=>{const s=${KZ};if(!s.state.judgmentPrefs.revealThumbedDown)s.actions.judgments.toggleReveal()})()`);
    await page.evaluate(`(async()=>${KZ}.actions.ui.refresh())()`);
    await page.poll(`(async()=>{const s=${KZ};return s.state.entriesWithKnownSize().some((_,i)=>s.state.feedEntryAt(i)?.filename===${JSON.stringify(names.bottomVideo)})})()`,30000);
    // A judged current entry must not contaminate the expected hover color.
    await page.evaluate(`(async()=>${KZ}.handles.invoke('judgment.apply',{id:'fake:flux-basic.png',intent:{type:'set',patch:{favorite:true,bookmark:null,vote:null}}}))()`);
    const currentColor=await page.evaluate(`(()=>{const probe=document.createElement('span');probe.style.color='var(--foreground-bright)';document.body.append(probe);const color=getComputedStyle(probe).color;probe.remove();return color})()`);
    await browse(names.top);
    await page.poll(`!!document.querySelector('.card.current .media-box.ic-loaded')`);
    const closed=await page.send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(workPath('artifacts/rail-preview-closed.png'),Buffer.from(closed.data,'base64'));
    // Touch may enter a row while panning, but must never start hover work.
    await page.evaluate(`document.querySelector(${JSON.stringify(selector(names.top))}).parentElement.dispatchEvent(new PointerEvent('pointerenter',{pointerType:'touch',bubbles:false}))`);
    await sleep(150);assert.equal(await page.evaluate(`!!document.querySelector('.fr-preview')`),false,'touch entry does not show a hover preview');
    await page.evaluate(`(async()=>${KZ}.actions.judgments.dispatch(${JSON.stringify('fake:'+names.top)},{type:'set',patch:{favorite:true,bookmark:null,vote:null}}))()`);
    const beforeHover=await tickStyle(names.top);
    await move(names.top);await sleep(60);
    assert.equal(await page.evaluate(`!!document.querySelector('.fr-preview')`),false,'short hover does not acquire/show preview');
    await shown(names.top);await page.poll(`document.querySelector('.fr-preview .media-box')?.classList.contains('ic-loaded')`);
    const highlighted=await tickStyle(names.top);
    assert.equal(highlighted.color,currentColor,'previewed tick uses foreground-bright, overriding treatment');
    assert.equal(highlighted.hovered,true,'displayed preview owns the hovered class');
    assert.equal(highlighted.width,beforeHover.width,'hover does not widen the tick');
    assert.equal(highlighted.height,beforeHover.height,'hover does not lengthen the tick');
    for(const patch of [{favorite:null,bookmark:true,vote:null},{favorite:null,bookmark:null,vote:'up'},{favorite:null,bookmark:null,vote:'down'}]){
      await page.evaluate(`(async()=>${KZ}.actions.judgments.dispatch(${JSON.stringify('fake:'+names.top)},{type:'set',patch:${JSON.stringify(patch)}}))()`);
      assert.deepEqual(await tickStyle(names.top),highlighted,'every treatment stays white at unchanged size while previewed');
    }
    await pixels([35,118,150,255]);
    assert.equal(await page.evaluate(`document.querySelectorAll('#feedRail[title],.fr-tick[title],.fr-row[title]').length`),0,'no tick or inherited native title tooltip');
    console.log('ok delayed image preview with truncated filename and no native tooltip',await geometry(names.top));
    await capture('rail-preview-image-top');
    await move(names.topVideo);await shown(names.topVideo);
    assert.equal((await tickStyle(names.top)).hovered,false,'moving clears the former tick');
    assert.notEqual((await tickStyle(names.top)).color,currentColor,'former tick restores its treatment');
    assert.equal((await tickStyle(names.topVideo)).color,currentColor,'highlight moves to the new preview target');
    assert.equal(await page.evaluate(`document.querySelectorAll('.fr-preview img,.fr-preview video,.fr-preview audio, .fr-preview button').length`),0,'video fallback is filename-only, no player or acquisition');
    await geometry(names.topVideo);await capture('rail-preview-video-top');
    console.log('ok moving ticks replaces image with filename-only video card');
    await page.mouse('mouseMoved',300,18,{buttons:0});await page.poll(`!document.querySelector('.fr-preview')`);
    assert.equal(await page.evaluate(`document.querySelectorAll('.fr-tick.hovered').length`),0,'leaving clears the tick highlight');
    console.log('ok leaving hides preview');
    // The central anchor is clear of both viewport edges: prove actual centering,
    // not only clamping at the top and bottom.
    const middle=await page.evaluate(`document.querySelectorAll('.fr-tick')[60].dataset.entryId.slice(5)`);
    await move(middle);await shown(middle);await page.poll(`document.querySelector('.fr-preview .media-box')?.classList.contains('ic-loaded')`);
    await geometry(middle);await capture('rail-preview-image-middle');
    const feed=await page.evaluate(`(()=>{const r=document.querySelector('#candidatesCol').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await page.mouse('mouseWheel',feed.x,feed.y,{deltaY:100});await page.poll(`!document.querySelector('.fr-preview')`);
    assert.equal(await page.evaluate(`document.querySelectorAll('.fr-tick.hovered').length`),0,'feed scroll clears the highlight');
    console.log('ok middle preview centers on its tick; feed scroll hides it');
    for(const [name,shot] of [[names.bottom,'rail-preview-image-bottom'],[names.bottomVideo,'rail-preview-video-bottom'],[names.audio,'rail-preview-audio']]){
      await browse(name);await move(name);await shown(name);
      if(name===names.bottom){await page.poll(`document.querySelector('.fr-preview .media-box')?.classList.contains('ic-loaded')`);await pixels([184,127,68,255])}
      await geometry(name);await capture(shot);
    }
    console.log('ok image/video previews clamp at bottom edge; audio uses filename-only');
    const p=await point(names.audio);await page.mouse('mousePressed',p.x,p.y,{buttons:1,clickCount:1});await page.poll(`!document.querySelector('.fr-preview')`);await page.mouse('mouseReleased',p.x,p.y,{buttons:0,clickCount:1});
    assert.equal(await page.evaluate(`document.querySelectorAll('.fr-tick.hovered').length`),0,'scrub start clears the highlight');
    console.log('ok scrub start hides preview');
    await browse(names.slowA);
    await page.send('Fetch.enable',{patterns:[{urlPattern:'*rail-preview-slow-*.png/bytes*'},{urlPattern:'*rail-preview-failed.png/bytes*'}]});
    await move(names.slowA);await shown(names.slowA);
    for(let i=0;i<30&&!active.size;i++)await sleep(30);
    assert.equal(active.size,1,'first hover image request is held in flight');
    await move(names.slowB);await shown(names.slowB);await page.poll(`document.querySelector('.fr-preview .media-box')?.classList.contains('ic-loaded')`);
    assert.equal(maximum,1,'at most one hover image request in flight');
    console.log('ok replacing a slow hover retires its native request before the next', {maximum});
    const wheel=await point(names.slowB);await page.mouse('mouseWheel',wheel.x,wheel.y,{deltaY:5});await page.poll(`!document.querySelector('.fr-preview')`);
    assert.equal(await page.evaluate(`document.querySelectorAll('.fr-tick.hovered').length`),0,'rail scroll clears the highlight');
    console.log('ok rail scroll hides preview');
    await browse(names.failed);await move(names.failed);await shown(names.failed);await page.poll(`document.querySelector('.fr-preview')?.textContent.includes('Preview unavailable')`);
    assert.equal(await page.evaluate(`document.querySelectorAll('.fr-preview img').length`),0,'failure has no native broken-image glyph');
    await geometry(names.failed);await capture('rail-preview-failed');
    console.log('ok image failure keeps filename and short reason without broken glyph');
    // A real narrow viewport must shrink the preview beside the rail, never
    // slide it over the trigger. Its media height must use that final width.
    await page.mouse('mouseMoved',300,18,{buttons:0});
    await page.send('Emulation.setDeviceMetricsOverride',{width:180,height:861,deviceScaleFactor:1,mobile:false});
    await browse(names.top);await move(names.top);await shown(names.top);
    await page.poll(`document.querySelector('.fr-preview .media-box')?.classList.contains('ic-loaded')`);
    const narrow=await page.evaluate(`(()=>{const panel=document.querySelector('.fr-preview'),p=panel.getBoundingClientRect(),rail=document.querySelector('#feedRail').getBoundingClientRect(),picture=panel.querySelector('.fr-preview-picture').getBoundingClientRect(),cs=getComputedStyle(panel);return{left:p.left,right:p.right,width:p.width,height:p.height,railRight:rail.right,vw:innerWidth,pictureHeight:picture.height,imageHeight:panel.querySelector('img').getBoundingClientRect().height,padding:parseFloat(cs.paddingTop)+parseFloat(cs.paddingBottom)+parseFloat(cs.borderTopWidth)+parseFloat(cs.borderBottomWidth),gap:parseFloat(cs.rowGap),label:panel.querySelector('.fr-preview-name').getBoundingClientRect().height}})()`);
    assert.equal(narrow.left,narrow.railRight+4,'narrow preview stays beside its trigger');
    assert.equal(narrow.right,narrow.vw-4,'narrow preview respects viewport margin');
    assert(narrow.width<160,'narrow preview shrinks');
    assert(Math.abs(narrow.pictureHeight-narrow.imageHeight)<0.5,'tall image allocation hugs the constrained image, without preferred-width surplus');
    assert(Math.abs(narrow.height-narrow.pictureHeight-narrow.padding-narrow.gap-narrow.label)<0.5,'panel height follows media at its actual constrained width');
    await capture('rail-preview-narrow');
    console.log('ok narrow viewport shrinks right-side preview without overlap or stale preferred-width height',narrow);
    assert.deepEqual(errors,[]);console.log('PASS rail-preview (11 consumer contracts, no page errors)');
  }catch(error){
    console.error('preview diagnostics',await page.evaluate(`({hover:matchMedia('(hover: hover)').matches,anyHover:matchMedia('(any-hover: hover)').matches,pointer:matchMedia('(pointer: fine)').matches,previews:[...document.querySelectorAll('.fr-preview')].map(el=>({text:el.textContent,class:el.className,html:el.outerHTML})),top:document.querySelector('.fr-top')?.textContent,ticks:[...document.querySelectorAll('.fr-tick')].slice(0,5).map(el=>({id:el.dataset.entryId,hover:el.matches(':hover')}))})`),errors);
    throw error;
  }finally{for(const timer of timers)clearTimeout(timer);await page.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
