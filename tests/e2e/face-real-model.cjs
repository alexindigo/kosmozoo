// Opt-in offline actual-model end-consumer proof. The task VM provides the
// retained model service and approved real-b.png fixture; no setup/downloads.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const ENGINE = process.env.E2E_ENGINE;
const SERVICE = process.env.FACE_REAL_SERVICE;
const FIXTURES = process.env.FACE_FIXTURES;
const E = process.env.FACE_EVIDENCE;
assert(ENGINE && SERVICE && FIXTURES && E, 'explicit owned guest environment required');
const KZ = `(await import('/store/instance.js')).appStore`;
(async () => {
  fs.mkdirSync(E, { recursive:true });
  const page = await CDP.launch(9392, { windowSize:'1600,1000' });
  const errors = await collectPageErrors(page);
  const invoke = (id,args={}) => page.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  try {
    await page.send('Emulation.setDeviceMetricsOverride',{width:1400,height:900,deviceScaleFactor:1,mobile:false});
    await page.goto(ENGINE+'/#faces');
    await page.poll(`!!document.querySelector('.card')`,20000);
    // The derivative is test input only: the original retained fixture is
    // translated/scaled on a larger canvas, then read through the real engine.
    const candidate = await page.evaluate(`(async()=>{
      const img=new Image();img.src='/api/collections/faces/entries/real-b.png/bytes';await img.decode();
      const c=document.createElement('canvas');c.width=c.height=1024;
      const x=c.getContext('2d');x.fillStyle='#18202c';x.fillRect(0,0,1024,1024);x.drawImage(img,96,80,768,768);
      return c.toDataURL('image/png').split(',')[1];
    })()`);
    fs.writeFileSync(path.join(FIXTURES,'real-a.png'),Buffer.from(candidate,'base64'));
    await invoke('source.refresh');
    await page.clickAt('#menuBtn'); await page.poll(`!!document.querySelector('#faceServiceUrl')`);
    await page.clickAt('#faceServiceUrl');await page.evaluate(`document.querySelector('#faceServiceUrl').select()`);
    await page.send('Input.insertText',{text:SERVICE});await page.clickAt('.face-settings button[type="submit"]');
    await page.poll(`document.querySelector('.face-settings [role="status"]')?.textContent==='Detector settings saved'`);
    const confirmed=await(await fetch(ENGINE+'/api/settings/plugins.detector')).json();assert.equal(confirmed.serviceUrl,SERVICE);
    await page.clickAt('#menuBtn');
    await invoke('workbench.openPair',{left:{source:'faces',file:'real-a.png'},right:{source:'faces',file:'real-b.png'}});
     await invoke('workbench.mode',{mode:'two-up'});
     assert.equal(await page.evaluate(`document.querySelector('#faceDetection').getAttribute('aria-pressed')`),'false');
     await page.clickAt('#faceDetection');
    await page.clickAt('#diffAlignment');await page.keyTrusted('End',{vk:35});await page.keyTrusted('Enter',{vk:13});
    await page.poll(`document.querySelectorAll('.dz-a .face-selected').length>0&&document.querySelectorAll('.dz-b .face-selected').length>0`,90000);
    for(const side of ['a','b']) {
      const point=await page.evaluate(`(async()=>{
        const r=${KZ}.actions['face-alignment'].acceptedRecord('${side}');
        if(r.anchor)return null;
        const face=r.faces.find(f=>f.eyes),box=document.querySelector('.dz-${side} img').getBoundingClientRect();
        if(!face)throw new Error('actual model returned no usable eyes');
        return{x:box.left+(face.bbox[0]+face.bbox[2])/2/r.w*box.width,y:box.top+(face.bbox[1]+face.bbox[3])/2/r.h*box.height};
      })()`);
      if(point)for(const clickCount of [1,2]) {
        await page.mouse('mousePressed',point.x,point.y,{clickCount,buttons:1});
        await page.mouse('mouseReleased',point.x,point.y,{clickCount,buttons:0});
      }
    }
    await page.poll(`document.querySelector('.dz-a .is-anchor')&&document.querySelector('.dz-b .is-anchor')`,10000);
    await invoke('workbench.mode',{mode:'one-up'});await invoke('workbench.parameters',{parameter:'activeOpacity',value:.5});
    const proof = await page.evaluate(`(async()=>{
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      const output={};
      for(const side of ['a','b']){
        const record=${KZ}.actions['face-alignment'].acceptedRecord(side),face=record.faces.find(f=>f.id===record.anchor);
        const center=start=>[0,1].map(axis=>face.kps.slice(start,start+6).reduce((n,p)=>n+p[axis],0)/6);
        const l=center(11),r=center(17),im=document.querySelector('.dz-'+side+' img'),box=im.getBoundingClientRect();
        const map=p=>[box.left+p[0]/im.naturalWidth*box.width,box.top+p[1]/im.naturalHeight*box.height];
        const left=map(l),right=map(r);
        output[side]={record,left,right,midpoint:left.map((n,i)=>(n+right[i])/2),distance:Math.hypot(left[0]-right[0],left[1]-right[1]),
          src:im.src,feedback:[...document.querySelectorAll('.dz-'+side+' .face-eye')].map(e=>{const b=e.getBoundingClientRect();return[b.left+b.width/2,b.top+b.height/2];})};
      }
      return output;
    })()`);
    for(const side of ['a','b']) {
      assert.equal(proof[side].record.detector.serviceUrl,SERVICE);
      assert.equal(proof[side].record.detector.model,'anime-face-detector');
      assert(proof[side].record.faces.length>0);assert.equal(proof[side].feedback.length,2);
      assert(proof[side].src.includes(proof[side].record.image.hash));
      for(let eye=0;eye<2;eye++)for(let axis=0;axis<2;axis++)
        assert(Math.abs(proof[side].feedback[eye][axis]-proof[side][eye?'right':'left'][axis])<.6,'real feedback follows actual pixels');
    }
    assert(Math.abs(proof.a.distance-proof.b.distance)<.6);
    proof.a.midpoint.forEach((n,i)=>assert(Math.abs(n-proof.b.midpoint[i])<.6));
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(E,'actual-model-consumer.json'),JSON.stringify({proof,errors,confirmed},null,2));
    if(process.env.FACE_SKIP_SCREENSHOTS !== '1') fs.writeFileSync(path.join(E,'actual-model-registered-overlap.png'),Buffer.from((await page.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
    console.log('ACTUAL MODEL TO BROWSER: selected faces, immutable displayed bytes, native/feedback geometry and registration agree');
    console.log(JSON.stringify({a:{hash:proof.a.record.image.hash,faces:proof.a.record.faces.length,midpoint:proof.a.midpoint,distance:proof.a.distance},b:{hash:proof.b.record.image.hash,faces:proof.b.record.faces.length,midpoint:proof.b.midpoint,distance:proof.b.distance}}));
  } catch(error) {
    fs.writeFileSync(path.join(E,'actual-model-failure.png'),Buffer.from((await page.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
    fs.writeFileSync(path.join(E,'actual-model-failure.json'),JSON.stringify({message:String(error.stack),errors},null,2));
    throw error;
  } finally {await page.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
