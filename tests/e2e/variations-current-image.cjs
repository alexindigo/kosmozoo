const assert = require('node:assert/strict');
const fs = require('node:fs');
const { openImageAdd, pickInput, waitForSelectedPreviews } = require('./image-picker-helpers.cjs');
const { workPath } = require('./paths.cjs');
const { addParameter } = require('./variation-add-helpers.cjs');
module.exports = async ({ cdp, KZ, FAKE, check }) => {
  const invoke = (id,args={}) => cdp.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const jobs = async () => (await fetch(FAKE+'/__test/enqueues')).json();
  const close = async () => {
    await cdp.evaluate(`(async()=>{${KZ}.handles.invoke('variations.close');return true})()`);
    if(await cdp.evaluate("!!document.querySelector('.vz-discard')")) await cdp.clickAt('.vz-discard-confirm');
    await cdp.poll("!document.querySelector('.vz-panel')");
  };
  await fetch(FAKE+'/__test/activity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({captureEnqueue:true})});
  try {
    if(await cdp.evaluate("!!document.querySelector('.vz-panel')")) await close();
    await fetch(FAKE+'/__test/activity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({publish:[{name:'portraits/flux-controlnet_00002_.png',fixture:'flux-controlnet.png',graphPrefix:'portraits/flux-controlnet'}]})});
    await invoke('source.refresh');
    await cdp.poll(`(async()=>${KZ}.state.images.some(image=>image.filename==='portraits/flux-controlnet_00002_.png'))()`,15000);
    for(const bulk of [false,true]) {
      const names = bulk ? ['flux-controlnet.png','portraits/flux-controlnet_00002_.png'] : ['flux-controlnet.png'];
      await invoke('variations.open', bulk ? {ids:names.map(n=>'fake:'+n),bulk:true} : {id:'fake:'+names[0]});
      await addParameter(cdp,'43.image');
      await require('./variation-add-helpers.cjs').removeRecordedImage(cdp,'43.image');
      await openImageAdd(cdp);
      assert(await cdp.evaluate("!!document.querySelector('.vz-current-image')"),'Current image acquisition button exists');
      const labels = await cdp.evaluate("[...document.querySelector('.vz-image-add').children].filter(e=>e.matches('button,.vz-input-picker')).map(e=>e.textContent.trim())");
      assert(labels.at(-1).startsWith('Current image'),JSON.stringify(labels));
      const buttonWidth = await cdp.evaluate("document.querySelector('.vz-current-image').getBoundingClientRect().width");
      await cdp.clickAt('.vz-current-image');
      assert.equal(await cdp.evaluate("document.querySelector('.vz-current-image').getAttribute('aria-pressed')"),'true');
      assert.equal(await cdp.evaluate("document.querySelector('.vz-current-image').textContent.trim()"),'Current image');
      assert(await cdp.evaluate("document.querySelector('.vz-current-image').classList.contains('is-on')"));
      assert.equal(await cdp.evaluate("document.querySelector('.vz-current-image').getBoundingClientRect().width"),buttonWidth);
      await cdp.poll("document.querySelectorAll('.vz-image-tile').length===1");
      await cdp.clickAt('.vz-current-image');
      await cdp.poll("document.querySelectorAll('.vz-image-tile').length===0");
      assert.equal(await cdp.evaluate("document.querySelector('.vz-current-image').textContent.trim()"),'Current image');
      assert.equal(await cdp.evaluate("document.querySelector('.vz-current-image').getAttribute('aria-pressed')"),'false');
      await cdp.clickAt('.vz-current-image');
      await pickInput(cdp,'ref.png');
      if(!bulk) await pickInput(cdp,'canny.png');
      await openImageAdd(cdp); await waitForSelectedPreviews(cdp);
      assert.equal(await cdp.evaluate("!!document.querySelector('.vz-image-each')"),bulk);
      await cdp.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
      const rowGeometry = await cdp.evaluate(`(()=>{const buttons=['.vz-input-trigger','.vz-imgfilespick + button','.vz-folder-trigger','.vz-current-image'].map(s=>document.querySelector(s).getBoundingClientRect());return buttons.map(r=>({x:r.x,y:r.y,right:r.right,height:r.height}))})()`);
      assert(rowGeometry.every((r,index)=>!index || r.x>=rowGeometry[index-1].right),JSON.stringify(rowGeometry));
      const self = await cdp.evaluate(`(()=>{const tile=document.querySelector('[data-image-kind="target"]');return {title:tile.title,src:tile.querySelector('img').src,loaded:tile.querySelector('img').naturalWidth>0}})()`);
      assert.equal(self.title,'Current image - each selected image uses itself'); assert(self.loaded&&self.src.includes('flux-controlnet.png')&&!self.src.includes('kind=input'),JSON.stringify(self));
      await cdp.evaluate("document.querySelector('.vz-current-image').focus()");
      const rowBox = await cdp.evaluate("(()=>{const r=document.querySelector('.vz-image-add').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()");
      const buttonBox = await cdp.evaluate("(()=>{const r=document.querySelector('.vz-current-image').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
      await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...buttonBox});
      const shot = await cdp.send('Page.captureScreenshot',{format:'png'});
      fs.mkdirSync(workPath('artifacts'),{recursive:true});fs.writeFileSync(workPath('artifacts',bulk?'current-image-bulk.png':'current-image-single.png'),Buffer.from(shot.data,'base64'));
      if(!bulk) {
        const crop = await cdp.send('Page.captureScreenshot',{format:'png',clip:{...rowBox,scale:2}});
        fs.writeFileSync(workPath('artifacts','current-image-row-2x.png'),Buffer.from(crop.data,'base64'));
      }
      if(!bulk) { await pickInput(cdp,'canny.png'); await openImageAdd(cdp); }
      const before = (await jobs()).length;
      const result = await invoke('variations.run');
      assert.equal(result.status,'submitted',JSON.stringify(result)+' '+await cdp.evaluate("document.querySelector('.vz-error')?.textContent"));assert.equal(result.submitted,names.length*2);
      const prompts = (await jobs()).slice(before);
      assert.deepEqual(prompts.map(p=>p.prompt['43'].inputs.image).sort(),names.flatMap(name=>[name+' [output]','ref.png']).sort());
      for(const name of names) {
        const own = prompts.find(p=>p.prompt['43'].inputs.image===name+' [output]');
        assert(Object.values(own.prompt).some(node=>node.class_type==='SaveImage'&&node.inputs.filename_prefix.includes(name.split('/').at(-1).replace(/\.[^.]+$/,''))));
      }
      await cdp.poll("!document.querySelector('.vz-panel')",6000);
      check('current image: '+(bulk?'each bulk target':'single target')+' queues own output reference with input, toggle on/off and thumbnail',true);
    }
  } finally {
    if(await cdp.evaluate("!!document.querySelector('.vz-panel')")) await close();
    await fetch(FAKE+'/__test/activity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({captureEnqueue:false,remove:['portraits/flux-controlnet_00002_.png']})});
  }
};
