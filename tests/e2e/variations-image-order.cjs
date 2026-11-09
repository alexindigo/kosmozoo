const assert = require('node:assert/strict');
const fs = require('node:fs');
const { pickInput, openImageAdd, waitForSelectedPreviews } = require('./image-picker-helpers.cjs');
const { freshRecipe } = require('./recipe-helpers.cjs');
const { addParameter } = require('./variation-add-helpers.cjs');

module.exports = async ({ cdp, check, FAKE, KZ }) => {
  const invoke = (id, args = {}) => cdp.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const order = () => cdp.evaluate("[...document.querySelectorAll('.vz-image-tile')].map(el=>el.dataset.imageName)");
  const jobs = async () => (await fetch(FAKE + '/__test/enqueues')).json();
  await fetch(FAKE + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ captureEnqueue: true }) });
  try {
    await invoke('variations.open', { id: 'fake:flux-controlnet.png' });
    await cdp.poll("!!document.querySelector('[data-catalogue-id=\"43.image\"]')"); await freshRecipe(cdp);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await addParameter(cdp,'43.image');
    await pickInput(cdp, 'canny.png');
    // Real decoded image content in deliberately mixed source aspect ratios.
    await cdp.evaluate(`(async()=>{
      const files=['flux-basic.png','flux-lora.png','flux-controlnet.png','flux-ipadapter.png','flux-pulid.png'];
      const data=new DataTransfer();
      for(let index=0;index<8;index++){
        const bitmap=await createImageBitmap(await(await fetch('/api/collections/fake/entries/'+files[index%files.length]+'/bytes')).blob());
        const canvas=document.createElement('canvas');canvas.width=[240,360,280,180][index%4];canvas.height=[360,240,280,360][index%4];
        const context=canvas.getContext('2d');context.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
        // The metadata fixtures are intentionally flat-color PNGs. Paint a
        // deterministic landscape so this screenshot actually exercises imagery.
        const w=canvas.width,h=canvas.height,hue=[205,24,175,275,340,45,220,150][index];
        const sky=context.createLinearGradient(0,0,0,h);sky.addColorStop(0,'hsl('+hue+' 50% 38%)');sky.addColorStop(1,'hsl('+((hue+35)%360)+' 65% 82%)');
        context.fillStyle=sky;context.fillRect(0,0,w,h);
        context.fillStyle='hsl(42 90% 87%)';context.beginPath();context.arc(w*(.25+(index%3)*.2),h*.26,w*.13,0,Math.PI*2);context.fill();
        for(let layer=0;layer<3;layer++){
          context.fillStyle='hsl('+((hue+15)%360)+' 30% '+(40-layer*10)+'%)';context.beginPath();context.moveTo(0,h);
          for(let x=0;x<=w+12;x+=12)context.lineTo(x,h*(.52+layer*.17)-Math.sin(x/w*5+index+layer)*h*.12);
          context.lineTo(w,h);context.closePath();context.fill();
        }
        context.fillStyle='hsl('+hue+' 30% 16%)';
        for(let tree=0;tree<5;tree++){const x=w*(.1+tree*.22),y=h*(.72+(tree%2)*.06);context.beginPath();context.moveTo(x,y-h*.16);context.lineTo(x-w*.045,y);context.lineTo(x+w*.045,y);context.fill();context.fillRect(x-1,y,2,h*.08);}
        const bytes=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
        data.items.add(new File([bytes],'grid-'+index+'.png',{type:'image/png'}));
      }
      const input=document.querySelector('.vz-imgfilespick');input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    await cdp.poll("document.querySelectorAll('.vz-image-tile').length===9&&!document.querySelector('.vz-image-check')");
    await waitForSelectedPreviews(cdp);
    const geometry = await cdp.evaluate(`(()=>{
      const tiles=[...document.querySelectorAll('.vz-image-tile,.vz-image-plus')],sizes=tiles.map(el=>{const r=el.getBoundingClientRect();return[r.width,r.height]}),
        current=document.querySelector('[data-image-name="canny.png"] .vz-image-same'),token=document.createElement('span');token.style.color='var(--attention)';document.body.append(token);
      const result={sizes,names:document.querySelector('.vz-image-grid').innerText,ring:getComputedStyle(current).boxShadow,orange:getComputedStyle(token).color,
        fit:[...document.querySelectorAll('.vz-image-tile img')].every(img=>getComputedStyle(img).objectFit==='contain'),
        ratios:[...new Set([...document.querySelectorAll('.vz-image-tile img')].map(img=>(img.naturalWidth/img.naturalHeight).toFixed(2)))]};token.remove();return result;
    })()`);
    assert(geometry.sizes.every(([w,h])=>Math.abs(w-geometry.sizes[0][0])<.5&&Math.abs(h-geometry.sizes[0][1])<.5));
    assert(geometry.sizes.every(([w,h])=>Math.abs(w-h)<.5), JSON.stringify(geometry));
    assert.equal(geometry.names.trim(), '+'); assert(geometry.ring.includes(geometry.orange)&&geometry.ring.includes('2px'));
    assert(geometry.fit&&geometry.ratios.length>=3, JSON.stringify(geometry));
    check('image grid: nine mixed-ratio images and add tile share square size; contain, orange inset ring and tooltip-only names', true);
    await openImageAdd(cdp);
    assert(await cdp.evaluate("document.querySelector('.vz-image-add').getBoundingClientRect().height>0&&document.querySelector('.vz-input-trigger').textContent.includes('ComfyUI inputs')&&document.querySelector('.vz-folder-trigger').textContent==='Add folder…'"));
    await cdp.clickAt('.vz-image-plus');
    const before = await order(), box = index => cdp.evaluate(`(()=>{const r=document.querySelectorAll('.vz-image-tile')[${index}].getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    const a = await box(2), b = await box(0);
    await cdp.mouse('mousePressed',a.x,a.y,{buttons:1});await cdp.mouse('mouseMoved',b.x,b.y,{buttons:1});
    await cdp.poll("[...document.querySelectorAll('.vz-image-tile')].some(el=>el.getAnimations().some(animation=>animation.effect.getTiming().duration===150))");
    assert(await cdp.evaluate("getComputedStyle(document.querySelector('.vz-image-dragging')).boxShadow!=='none'"));
    await cdp.mouse('mouseReleased',b.x,b.y,{buttons:0});
    const dragged = [before[2],before[0],before[1],...before.slice(3)];
    await cdp.poll(`[...document.querySelectorAll('.vz-image-tile')].map(el=>el.dataset.imageName).join('|')===${JSON.stringify(dragged.join('|'))}`);
    await cdp.evaluate("document.querySelector('.vz-image-tile').focus()");
    for (const type of ['rawKeyDown','keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key:'ArrowRight', code:'ArrowRight', windowsVirtualKeyCode:39, modifiers:1 });
    const moved = [before[0],before[2],before[1],...before.slice(3)];
    await cdp.poll(`[...document.querySelectorAll('.vz-image-tile')].map(el=>el.dataset.imageName).join('|')===${JSON.stringify(moved.join('|'))}`);
    // Reload the grid from its recipe, without a second presentation-order owner.
    await cdp.clickAt('.vz-image-set .checkbox'); await addParameter(cdp,'43.image');
    await waitForSelectedPreviews(cdp); assert.deepEqual(await order(), moved);
    check('image order: trusted pointer tile 3 before 1 and Alt+Right update recipe; grid reload preserves exact order', true);
    await cdp.evaluate("document.activeElement.blur();document.querySelector('.vz-sliders').scrollTop=0");
    if(process.env.E2E_IMAGE_SHOT){const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(process.env.E2E_IMAGE_SHOT,Buffer.from(shot.data,'base64'));}
    await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    const reducedFrom=await box(2),reducedTo=await box(0);
    await cdp.mouse('mousePressed',reducedFrom.x,reducedFrom.y,{buttons:1});await cdp.mouse('mouseMoved',reducedTo.x,reducedTo.y,{buttons:1});
    await cdp.poll("!!document.querySelector('.vz-image-dragging')");
    assert(await cdp.evaluate("[...document.querySelectorAll('.vz-image-tile')].every(el=>el.getAnimations().length===0)"));
    await cdp.mouse('mouseReleased',reducedTo.x,reducedTo.y,{buttons:0});
    await cdp.send('Emulation.setEmulatedMedia',{features:[]});
    check('image grid: dragged tile lifts with shadow, other tiles FLIP for 150ms; reduced motion disables FLIP',true);
    // Touch uses the same Pointer Events path. Cancel must roll back its preview.
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled:true });
    const touchFrom=await box(2),touchTo=await box(0),retained=await order();
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:touchFrom.x,y:touchFrom.y,id:1}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:touchTo.x,y:touchTo.y,id:1}]});
    await cdp.poll("!!document.querySelector('.vz-image-dragging')");
    await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
    await cdp.poll("!document.querySelector('.vz-image-dragging')");assert.deepEqual(await order(),retained);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:touchFrom.x,y:touchFrom.y,id:2}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:touchTo.x,y:touchTo.y,id:2}]});
    await cdp.poll("!!document.querySelector('.vz-image-dragging')");
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await cdp.poll(`[...document.querySelectorAll('.vz-image-tile')].map(el=>el.dataset.imageName).join('|')!==${JSON.stringify(retained.join('|'))}`);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled:false });
    check('image order: trusted touch drag commits, touch cancellation restores the recipe order',true);
    // Long sheet: edge scrolling runs on animation frames, even if the pointer stops.
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:600,height:600,deviceScaleFactor:1,mobile:false});
    await cdp.evaluate("document.querySelector('.vz-sliders').scrollTop=0");
    const from=await box(0),edge=await cdp.evaluate("(()=>{const r=document.querySelector('.vz-sliders').getBoundingClientRect();return{x:r.x+r.width/2,y:r.bottom-8}})()");
    await cdp.mouse('mousePressed',from.x,from.y,{buttons:1});await cdp.mouse('mouseMoved',edge.x,edge.y,{buttons:1});
    await cdp.poll("document.querySelector('.vz-sliders').scrollTop>50");
    await cdp.mouse('mouseReleased',edge.x,edge.y,{buttons:0});
    check('image order: dragging near the parameter-list edge auto-scrolls a long sheet',true);
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false});
    for(const key of ['Delete','Backspace']){
      const length=(await order()).length;await cdp.evaluate("document.querySelector('.vz-image-tile').focus()");
      await cdp.keyTrusted(key,{vk:key==='Delete'?46:8});await cdp.poll(`document.querySelectorAll('.vz-image-tile').length===${length-1}`);
    }
    check('image grid: Delete and Backspace each remove the focused tile',true);
    const finalOrder = await order(), count=(await jobs()).length, result=await invoke('variations.run');
    assert.equal(result.status,'submitted'); assert.equal(result.adopted,true);
    const submitted=(await jobs()).slice(count).map(job=>job.prompt['43'].inputs.image);
    assert.deepEqual(submitted,finalOrder.filter(name=>name!=='canny.png'));
    check('image order: actual captured fake enqueues follow the final dragged/deleted order exactly (unchanged current excluded)', true);
    await invoke('variations.close');
    await invoke('variations.open', { id: 'fake:flux-controlnet.png' });
    await cdp.poll("!!document.querySelector('[data-catalogue-id=\"43.image\"]')");
    assert.deepEqual(await order(), []);
    assert.equal(await cdp.evaluate("!!document.querySelector('.vz-image-set')"),false);
    check('image order: full editor close/reopen starts with an empty image set, not the prior ordered Files', true);
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    if(await cdp.evaluate("!!document.querySelector('.vz-panel')")){
      await cdp.evaluate(`(async()=>{${KZ}.handles.invoke('variations.close');return true})()`);
      if(await cdp.evaluate("!!document.querySelector('.vz-discard')"))await cdp.clickAt('.vz-discard-confirm');
    }
    await fetch(FAKE+'/__test/activity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({captureEnqueue:false})});
  }
};
