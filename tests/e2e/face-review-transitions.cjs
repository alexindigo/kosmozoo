const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {CDP,collectPageErrors,sleep}=require('./cdp.cjs');
const ENGINE=process.env.E2E_ENGINE, DETECTOR=process.env.E2E_DETECTOR;
const E=process.env.FACE_EVIDENCE;
const KZ="(await import('/store/instance.js')).appStore";
(async()=>{
 fs.mkdirSync(E,{recursive:true});
 const page=await CDP.launch(9395,{windowSize:'1600,1000'}),errors=await collectPageErrors(page),proofs=[],failures=[];
 const {face}=await import('../helpers/face-fixtures.mjs');
 const normalA=[face(256,256,160,.01),face(75,75,32,100)];
 const invoke=(id,args={})=>page.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
 const config=async body=>assert((await fetch(DETECTOR+'/__test/config',{method:'POST',body:JSON.stringify(body)})).ok);
 const frames=()=>page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 const record=side=>page.evaluate(`(async()=>${KZ}.actions['face-alignment'].acceptedRecord('${side}'))()`);
 const rect=side=>page.evaluate(`document.querySelector('.dz-${side} img').getBoundingClientRect().toJSON()`);
 const capture=async name=>{await frames();fs.writeFileSync(path.join(E,name+'.png'),Buffer.from((await page.send('Page.captureScreenshot',{format:'png'})).data,'base64'));};
 const open=async(a,b,mode='two-up')=>{
  await invoke('workbench.openPair',{left:{source:a[0],file:a[1]},right:{source:b[0],file:b[1]}});
  await invoke('workbench.mode',{mode});await invoke('workbench.alignment',{mode:'face'});
  await page.poll(`(async()=>!!${KZ}.actions['face-alignment'].acceptedRecord('a')&&!!${KZ}.actions['face-alignment'].acceptedRecord('b'))()`,20000);
 };
 const choose=async(side,index)=>{const r=await record(side);assert(await invoke('faces.use',{side,record:r.id,face:r.faces[index].id}));await frames();};
 const point=async(side,index)=>page.evaluate(`(async()=>{const r=${KZ}.actions['face-alignment'].acceptedRecord('${side}'),f=r.faces[${index}],im=document.querySelector('.dz-${side} img'),b=im.getBoundingClientRect();return{x:b.left+(f.bbox[0]+f.bbox[2])/2/r.w*b.width,y:b.top+(f.bbox[1]+f.bbox[3])/2/r.h*b.height};})()`);
 const doubleClick=async p=>{for(const clickCount of [1,2]){await page.mouse('mousePressed',p.x,p.y,{clickCount,buttons:1});await page.mouse('mouseReleased',p.x,p.y,{clickCount,buttons:0});}await frames();};
 const attempt=async(name,run)=>{try{await run();console.log('PASS',name);}catch(e){failures.push({name,error:String(e.stack)});console.log('FAIL',name,String(e));await capture('failure-'+name).catch(()=>{});}finally{await invoke('menu.close');}};
 const bytes=async name=>Buffer.from(await(await fetch(DETECTOR+'/fixtures/'+name)).arrayBuffer());
 const aBytes=await bytes('multi-a.png'),bBytes=await bytes('multi-b.png'),singleBytes=await bytes('single.png');
 const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
 try{
  await page.send('Emulation.setDeviceMetricsOverride',{width:1400,height:900,deviceScaleFactor:1,mobile:false});
  await config({delay:0,fail:false,ready:true});
  await page.goto(ENGINE+'/#faces#multi-a.png');
  await page.poll(`(async()=>{const s=${KZ};return s.state.current()?.image==='multi-a.png'&&!s.state.inventory.loading&&s.state.images.length>0&&!!document.querySelector('.card');})()`,20000);
  await invoke('faces.settings.edit',{value:DETECTOR});await invoke('faces.settings.save');
  await fetch(ENGINE+'/api/collections/faces/entries/multi-a.png/bytes');await fetch(ENGINE+'/api/collections/faces/entries/multi-b.png/bytes');await invoke('source.refresh');
  await attempt('button-presentation',async()=>{
   await open(['faces','multi-a.png'],['faces','multi-b.png']);
   assert(await page.evaluate(`[...document.querySelectorAll('.face-choice')].every(b=>b.classList.contains('viewer-btn'))`),'face actions use the viewer button base');
   await invoke('workbench.hide');await invoke('menu.toggle');
   await page.poll(`!!document.querySelector('.face-settings button')`);
   assert(await page.evaluate(`document.querySelector('.face-settings button').classList.contains('btn')`),'Save uses the normal button base');
  });
  await attempt('mixed-unusable-choice',async()=>{
   await config({records:{[hash(aBytes)]:{w:512,h:512,faces:[normalA[0],{...normalA[1],kps:[]}]}}});
   try{
    await open(['faces','multi-a.png'],['faces','multi-b.png']);await choose('a',0);await choose('b',0);
    const before=await record('a');await doubleClick(await point('a',1));
    await page.poll(`document.querySelector('.face-status')?.dataset.phase==='choice-error'`);
    assert(await page.evaluate(`document.querySelector('.face-status').textContent.includes('eye landmarks')`));
    const after=await record('a');assert.equal(after.anchor,before.anchor);assert.equal(after.faces.filter(f=>f.selected).length,2);
    await capture('mixed-unusable-choice');
    const stale={side:'a',record:before.id,face:before.faces[1].id};
    await open(['faces','multi-a.png'],['faces','multi-b.png']);assert.equal(await invoke('faces.use',stale),false);
    assert.notEqual(await page.evaluate(`document.querySelector('.face-status').dataset.phase`),'choice-error');
    proofs.push({name:'mixed unusable face retains prior anchor and selected boxes; stale reason fenced',before,after});
   }finally{await config({records:{[hash(aBytes)]:{w:512,h:512,faces:normalA}}});}
  });
  for(const change of ['mode','resize'])await attempt('gesture-'+change+'-retirement',async()=>{
   await open(['faces','multi-a.png'],['faces','multi-b.png'],change==='mode'?'one-up':'two-up');
   await choose('a',0);await choose('b',0);
   const start={x:350,y:350};
   await page.mouse('mousePressed',start.x,start.y,{clickCount:1,buttons:1});
   try{
    if(change==='mode')await invoke('workbench.mode',{mode:'two-up'});
    else await page.send('Emulation.setDeviceMetricsOverride',{width:1000,height:800,deviceScaleFactor:1,mobile:false});
    await frames();const before=await rect('b');
    await page.mouse('mouseMoved',start.x+25,start.y+8,{buttons:1});await frames();
    const retired=await rect('b');
    for(const k of ['left','top','width','height'])assert(Math.abs(retired[k]-before[k])<.6,change+' must retire the captured old mapping: '+JSON.stringify({before,retired}));
    proofs.push({name:'independent '+change+' retirement',before,retired});
   }finally{
    await page.mouse('mouseReleased',start.x+25,start.y+8,{clickCount:1,buttons:0});
    await page.send('Emulation.setDeviceMetricsOverride',{width:1400,height:900,deviceScaleFactor:1,mobile:false});
   }
  });
  await attempt('reference-and-gesture-lifetimes',async()=>{
   const dir=process.env.FACE_MUTABLE,fa=path.join(dir,'review-a.png'),fb=path.join(dir,'review-b.png');
   assert(!fs.existsSync(fa)&&!fs.existsSync(fb),'review fixtures have an exclusive lifetime');
   fs.writeFileSync(fa,aBytes);fs.writeFileSync(fb,bBytes);
   const fresh=async(name,expected)=>{const until=Date.now()+15000;for(;;){const r=Buffer.from(await(await fetch(ENGINE+'/api/collections/mut/entries/'+name+'/bytes')).arrayBuffer());if(r.equals(expected))break;assert(Date.now()<until,'fixture content reached engine');await sleep(150);}};
   try{
    await fresh('review-a.png',aBytes);await fresh('review-b.png',bBytes);
    await invoke('source.select',{id:'mut'});await invoke('source.refresh');
    await open(['mut','review-a.png'],['mut','review-b.png'],'one-up');await choose('a',0);await choose('b',0);
    const session=await page.evaluate(`(async()=>${KZ}.state.diff.session)()`);
    await page.drag(650,360,670,375);await page.mouse('mouseWheel',670,375,{modifiers:2,deltaY:-20,deltaX:0});await frames();
    const stable=await rect('b');await choose('b',1);
    const sameB=await rect('b');assert(Math.abs(stable.left-sameB.left)<.6&&Math.abs(stable.width-sameB.width)<.6,'B anchor choice retains common camera');
    const crop={version:2,s:2.5,cx:.3,cy:.6};
    await page.evaluate(`(async()=>${KZ}.actions.diff.views.set('mut:review-b.png',${JSON.stringify(crop)}))()`);
    fs.writeFileSync(fb,singleBytes);const future=new Date(Date.now()+5000);fs.utimesSync(fb,future,future);
    await fresh('review-b.png',singleBytes);await invoke('source.refresh');
    await page.poll(`document.querySelector('.dz-b img')?.src.includes('${hash(singleBytes)}')&&!!document.querySelector('.dz-b .is-anchor')`,20000);
    await frames();assert.equal(await page.evaluate(`(async()=>${KZ}.state.diff.session)()`),session,'accepted B changed inside one viewer session');
    const expected=await page.evaluate(`(()=>{const s=document.querySelector('#diffStage').getBoundingClientRect();return{left:s.left+s.width/2-.3*1280,top:s.top+s.height/2-.6*1280,width:1280,height:1280};})()`);
    const replaced=await rect('b');for(const k of ['left','top','width','height'])assert(Math.abs(replaced[k]-expected[k])<.6,'new accepted B seeds its own current crop: '+JSON.stringify({replaced,expected}));
    await capture('new-reference-crop');
    // A changes and face choices cannot re-seed the same accepted B.
    await page.evaluate(`(async()=>${KZ}.actions.diff.views.set('mut:review-b.png',{version:2,s:1.2,cx:.6,cy:.5}))()`);
    fs.writeFileSync(fa,bBytes);fs.utimesSync(fa,future,future);await fresh('review-a.png',bBytes);await invoke('source.refresh');
    await page.poll(`document.querySelector('.dz-a img')?.src.includes('${hash(bBytes)}')`,20000);await choose('a',0);
    const afterA=await rect('b');for(const k of ['left','top','width','height'])assert(Math.abs(afterA[k]-replaced[k])<.6,'candidate replacement cannot reset B camera');
    const raw=await page.evaluate(`(async()=>JSON.stringify(${KZ}.state.diff.views))()`);
    for(const change of ['mode','resize']){
     const start=await page.evaluate(`(()=>{const r=document.querySelector('.dz-a').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`);
     await page.mouse('mousePressed',start.x,start.y,{clickCount:1,buttons:1});
     if(change==='mode')await invoke('workbench.mode',{mode:'two-up'});
     else await page.send('Emulation.setDeviceMetricsOverride',{width:1000,height:800,deviceScaleFactor:1,mobile:false});
     await frames();const before=await rect('b');
     await page.mouse('mouseMoved',start.x+25,start.y+8,{buttons:1});await frames();
     const retired=await rect('b');for(const k of ['left','top','width','height'])assert(Math.abs(retired[k]-before[k])<.6,change+' retires captured old mapping');
     await page.mouse('mouseReleased',start.x+25,start.y+8,{clickCount:1,buttons:0});
     const next=await page.evaluate(`(()=>{const r=document.querySelector('.dz-a').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`);
     await page.drag(next.x,next.y,next.x+20,next.y+10);await frames();
     const moved=await rect('b');assert(Math.abs(moved.left-before.left-20)<.6&&Math.abs(moved.top-before.top-10)<.6,'fresh '+change+' gesture uses the current allocation');
     proofs.push({name:change+' during drag',before,retired,moved});
    }
    assert.equal(await page.evaluate(`(async()=>JSON.stringify(${KZ}.state.diff.views))()`),raw,'camera and retired gestures never write raw crops');
    proofs.push({name:'accepted reference content seeds crop; A replacement/anchor choice retain camera',session,crop,expected,replaced,afterA});
   }finally{fs.unlinkSync(fa);fs.unlinkSync(fb);}
  });
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(E,'transition-proofs.json'),JSON.stringify({proofs,failures,errors},null,2));
  assert.equal(failures.length,0,JSON.stringify(failures));console.log('FACE REVIEW TRANSITIONS: ALL PASS');
 }finally{await page.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
