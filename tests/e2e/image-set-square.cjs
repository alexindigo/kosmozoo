// Real-browser allocation contract for both Thumbnail consumers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { workPath } = require('./paths.cjs');
const { openImageAdd, waitForInputPicker, waitForSelectedPreviews } = require('./image-picker-helpers.cjs');
const { addParameter } = require('./variation-add-helpers.cjs');
const ENGINE = process.env.E2E_ENGINE ?? 'http://127.0.0.1:18260';
const FAKE = process.env.E2E_FAKE ?? 'http://127.0.0.1:18261';
const KZ = '(await import("/store/instance.js")).appStore';

module.exports = async ({ cdp, check = () => {} }) => {
  const out = workPath('artifacts', process.env.SQUARE_EVIDENCE || 'image-set-square');
  fs.mkdirSync(out, { recursive: true });
  const viewport = await cdp.evaluate('({width:innerWidth,height:innerHeight})');
  const records = [], problems = [];
  const inspect = async (label, selector, picker = false) => {
    const rows = await cdp.evaluate(`(() => [...document.querySelectorAll(${JSON.stringify(selector)})].map(tile => {
      const box=tile.getBoundingClientRect(), image=tile.querySelector('img'), rect=image?.getBoundingClientRect(), style=image&&getComputedStyle(image);
      return {name:tile.dataset.imageName||tile.dataset.inputName||tile.getAttribute('aria-label'),width:box.width,height:box.height,
        natural:image&&[image.naturalWidth,image.naturalHeight],fit:style?.objectFit,position:style?.objectPosition,
        center:rect&&[Math.abs(rect.x+rect.width/2-box.x-box.width/2),Math.abs(rect.y+rect.height/2-box.y-box.height/2)]};
    }))()`);
    records.push({ label, rows });
    assert(rows.length >= 3, `${label}: missing mixed-aspect tiles`);
    for (const row of rows) {
      if (Math.abs(row.width-row.height) > .5 || row.width <= 0) problems.push(`${label}/${row.name}: ${row.width} × ${row.height}`);
      if (picker && (Math.abs(row.width-96) > .5 || Math.abs(row.height-96) > .5)) problems.push(`${label}/${row.name}: picker must be 96 px`);
      if (row.natural && (row.fit !== 'contain' || row.position !== '50% 50%' || row.center.some(n => n > .5))) problems.push(`${label}/${row.name}: preview must be contained and centred`);
    }
    console.log(label, JSON.stringify(rows));
  };
  const capture = async name => {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${out}/${name}.png`, Buffer.from(shot.data, 'base64'));
  };
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await cdp.goto(ENGINE + '/#fake#flux-controlnet.png');
    await cdp.poll(`(async()=>${KZ}.state.images.length>0&&!!document.querySelector('.card'))()`);
    // Generate honest, distinct portrait/landscape/square PNGs from a real fixture.
    const fixtures = await cdp.evaluate(`(async()=>{
      const image=new Image();image.src='/api/collections/fake/entries/flux-lora.png/bytes';await image.decode();
      return [[240,400,'portrait'],[480,240,'landscape'],[320,320,'square']].map(([width,height,shape])=>{
        const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
        canvas.getContext('2d').drawImage(image,0,0,width,height);
        return {name:'square-check-'+shape+'.png',bytes:canvas.toDataURL('image/png').split(',')[1]};
      });
    })()`);
    for (const fixture of fixtures) {
      const form = new FormData();form.append('image',new Blob([Buffer.from(fixture.bytes,'base64')]),fixture.name);
      const response = await fetch(FAKE+'/api/upload/image',{method:'POST',body:form});
      assert(response.ok || response.status === 409, `upload ${fixture.name}: ${response.status}`);
    }
    // A portrait current input makes any accidental current-aspect coupling visible.
    const name = 'square-check-target.png', graph = {
      '470': {class_type:'LoadImage',inputs:{image:'square-check-portrait.png'}},
      '461': {class_type:'SaveImage',inputs:{filename_prefix:'square-check-target',images:['470',0]}},
    };
    assert((await fetch(FAKE+'/__test/activity',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({publish:[{name,fixture:'flux-basic.png',graph,mtime:2100000500}]})})).ok);
    await cdp.evaluate(`fetch('/api/collections/fake/entries/${name}/bytes').then(r=>r.arrayBuffer()).then(()=>true)`);
    await cdp.evaluate(`(async()=>${KZ}.handles.invoke('variations.open',{id:'fake:${name}'}))()`);
    await addParameter(cdp, '470.image');
    await openImageAdd(cdp);await cdp.clickAt('.vz-input-trigger');await waitForInputPicker(cdp);
    await cdp.send('Input.insertText',{text:'square-check-'});
    await cdp.poll("document.querySelectorAll('.vz-input-option').length===3");
    await cdp.poll("[...document.querySelectorAll('.vz-input-option img')].every(img=>img.complete&&img.naturalWidth>0)");
    await inspect('picker','.vz-input-option',true);
    for (const fixture of fixtures) await cdp.clickAt(`[data-input-name="${fixture.name}"]`);
    await cdp.keyTrusted('Escape',{vk:27});
    await cdp.poll("document.querySelectorAll('.vz-image-tile').length===3");
    await waitForSelectedPreviews(cdp);
    await cdp.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const aspects = await cdp.evaluate("[...document.querySelectorAll('.vz-image-tile img')].map(img=>Math.sign(img.naturalWidth-img.naturalHeight)).sort()");
    assert.deepEqual(aspects,[-1,0,1],'portrait, square and landscape really decoded');
    for (const width of [1440, 800, 500]) {
      await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
      await cdp.evaluate("document.querySelector('.vz-image-grid').scrollIntoView({block:'center'})");
      await inspect(`selected-${width}`,'.vz-image-tile');
      await inspect(`sheet-${width}`,'.vz-image-tile, .vz-image-plus');
    }
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await cdp.evaluate("document.querySelector('.vz-sliders').scrollTop=0");
    await capture('panel');
    const clip = await cdp.evaluate("(()=>{const r=document.querySelector('.vz-image-set').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,scale:2}})()");
    const shot = await cdp.send('Page.captureScreenshot',{format:'png',clip});
    fs.writeFileSync(`${out}/panel-detail.png`,Buffer.from(shot.data,'base64'));
    fs.writeFileSync(`${out}/geometry.json`,JSON.stringify({records,problems},null,2));
    assert.deepEqual(problems,[],'all contact-sheet and picker allocations stay square with centred, contained images');
    check('mixed-aspect selected tiles stay square across widths; picker tiles stay 96 px square',true);
  } finally {
    await cdp.evaluate(`(async()=>{${KZ}.handles.invoke('variations.close');return true})()`);
    if(await cdp.evaluate("!!document.querySelector('.vz-discard')")) await cdp.clickAt('.vz-discard-confirm');
    await fetch(FAKE+'/__test/activity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({remove:['square-check-target.png']})});
    await cdp.send('Emulation.setDeviceMetricsOverride',{...viewport,deviceScaleFactor:1,mobile:false});
  }
};

if (require.main === module) (async()=>{
  const cdp=await CDP.launch(9357,{windowSize:'1440,1000'}), errors=await collectPageErrors(cdp);
  try { await module.exports({cdp,check:message=>console.log('ok',message)});assert.deepEqual(errors,[]); }
  finally { await cdp.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
