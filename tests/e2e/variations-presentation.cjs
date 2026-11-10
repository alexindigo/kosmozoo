const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { addParameter } = require('./variation-add-helpers.cjs');
const { captureReviewRegions } = require('./variation-capture-helpers.cjs');
const ENGINE = process.env.E2E_ENGINE, E = process.env.E2E_EVIDENCE;
const KZ = `(await import('/store/instance.js')).appStore`;
(async () => {
  const cdp = await CDP.launch(19454, {windowSize:'1600,1000'}), errors = await collectPageErrors(cdp);
  const shot = async name => { const {data} = await cdp.send('Page.captureScreenshot',{format:'png'}); fs.writeFileSync(`${E}/${name}.png`,Buffer.from(data,'base64')); await captureReviewRegions(cdp,E,name); };
  const write = async (selector,text) => {await cdp.clickAt(selector);await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`);await cdp.send('Input.insertText',{text});};
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false});
    if (process.env.E2E_VARIATIONS_CASE === 'real') {
      await cdp.goto(ENGINE + '/#fake#flux-controlnet.png');
      await cdp.poll('!!document.querySelector(".card .variations")',20000);
      await cdp.evaluate(`(async()=>{await fetch('/api/collections/fake/entries/flux-controlnet.png/bytes');return ${KZ}.handles.invoke('variations.open',{id:'fake:flux-controlnet.png'})})()`);
      await cdp.poll('document.querySelectorAll(".vz-catalogue-row").length>10');
      assert.deepEqual(await cdp.evaluate('[...document.querySelectorAll(".vz-catalogue-section-name")].map(el=>el.textContent)'),['Images','Text','Adjustments','Other inputs']);
      assert.equal(await cdp.evaluate('[...document.querySelectorAll(".vz-catalogue-section")].find(el=>el.querySelector(".vz-catalogue-section-name").textContent==="Adjustments").querySelector(".vz-catalogue-row").dataset.catalogueId'),'9.denoise');
      assert(await cdp.evaluate('[...document.querySelectorAll(".vz-catalogue-row")].every(row=>getComputedStyle(row.querySelector(".vz-catalogue-current")).color===getComputedStyle(row.closest(".vz-catalogue-node").querySelector(".vz-catalogue-node-name")).color&&getComputedStyle(row.querySelector(".vz-catalogue-current")).color!==getComputedStyle(row.querySelector(".vz-catalogue-name")).color)'));
      await shot('real-catalogue');
      for (const id of ['43.image','9.denoise','2.text','9.scheduler']) await addParameter(cdp,id);
      const current='[data-enum-id="9.scheduler"] .vz-enum-current';
      const chosen=await cdp.evaluate(`getComputedStyle(document.querySelector('${current} .vz-enum-opt-name')).color`);
      await cdp.clickAt(current+' input');
      assert.notEqual(await cdp.evaluate(`getComputedStyle(document.querySelector('${current} .vz-enum-opt-name')).color`),chosen);
      await shot('real-backend-current');
      await cdp.clickAt(current+' input');
      await cdp.evaluate('document.querySelector(".vz-sliders").scrollTop=0');
      await shot('real-filled');
      assert.deepEqual(errors,[]);
      console.log('PASS real graph: complete section hierarchy, denoise priority, four native editor kinds, backend current muted and chosen values foreground');
      return;
    }
    await cdp.goto(ENGINE + '/#fake#allparams_00001_.png');
    await cdp.poll('!!document.querySelector(".card .variations")',20000);
    await cdp.evaluate(`(async()=>{await fetch('/api/collections/fake/entries/allparams_00001_.png/bytes');return ${KZ}.handles.invoke('variations.open',{id:'fake:allparams_00001_.png'})})()`);
    await cdp.poll('document.querySelectorAll(".vz-catalogue-row").length===17');
    assert.deepEqual(await cdp.evaluate('[...document.querySelectorAll(".vz-catalogue-section-name")].map(el=>el.textContent)'),['Images','Text','Adjustments','Other inputs']);
    assert.equal(await cdp.evaluate('document.querySelectorAll(".vz-parameter").length'),0);
    assert(await cdp.evaluate('[...document.querySelectorAll(".vz-catalogue-add")].every(el=>el.querySelector("svg")&&!el.textContent.includes("->"))'));
    await shot('catalogue');
    await write('.vz-field-filter input','92:106');
    assert(await cdp.evaluate('[...document.querySelectorAll(".vz-catalogue-row:not(.vz-catalogue-hidden)")].every(el=>el.dataset.catalogueId.startsWith("92:106."))'));
    await write('.vz-field-filter input','');
    for (const id of ['76.image','92:105.text','92:105.seed','92:105.flag','92:105.choice','92:105.object','92:105.connection']) await addParameter(cdp,id);
    assert.equal(await cdp.evaluate('document.querySelectorAll(".vz-parameter-heading input").length'),0);
    await cdp.evaluate(`(async()=>{const bytes=await(await fetch('/api/collections/fake/entries/flux-lora.png/bytes')).arrayBuffer(),files=new DataTransfer(),input=document.querySelector('.vz-imgfilespick');window.__presentationFile=new File([bytes],'presentation.png',{type:'image/png'});files.items.add(window.__presentationFile);input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await cdp.poll('document.querySelector(".vz-image-tile img")?.naturalWidth>0');
    await cdp.clickAt('[data-image-id="76.image"] .vz-parameter-remove');await addParameter(cdp,'76.image');
    await cdp.poll('document.querySelector(".vz-image-tile img")?.naturalWidth>0');
    assert.equal(await cdp.evaluate('document.querySelector(".vz-image-tile").dataset.imageName'),'presentation.png');
    await cdp.evaluate('document.querySelector("[data-image-id=\\"76.image\\"]").scrollIntoView({block:"center"})');
    await shot('image-file-restored');
    await write('[data-text-id="92:105.text"] textarea','chosen text');
    await write('[data-candidate-id="92:105.object"] textarea','{ "incomplete":');
    const textarea='[data-candidate-id="92:105.object"] textarea';
    await cdp.evaluate(`window.__field=document.querySelector('${textarea}');window.__field.focus();window.__field.setSelectionRange(3,5)`);
    await cdp.send('Input.insertText',{text:'typed'});
    assert(await cdp.evaluate(`document.querySelector('${textarea}')===window.__field&&document.activeElement===window.__field&&window.__field.selectionStart===8`));
    const raw=await cdp.evaluate('window.__field.value');
    await cdp.clickAt('[data-candidate-id="92:105.object"] .vz-parameter-remove');await addParameter(cdp,'92:105.object');
    assert.equal(await cdp.evaluate(`document.querySelector('${textarea}').value`),raw);
    const link='[data-candidate-id="92:105.connection"]';
    const unknown=process.env.E2E_VARIATIONS_CASE==='unknown';
    if (unknown) {
      const slot=link+' input[type=text]';
      await write(slot,'1e');await cdp.clickAt('.vz-run');
      assert.equal(await cdp.evaluate(`document.querySelector('${slot}').value`),'1e');
      await shot('unknown-slot-error');
      await write(slot,'0');
    } else {
      assert.equal(await cdp.evaluate(`document.querySelector('${link} input[type=text]')`),null);
      assert(await cdp.evaluate(`[...document.querySelector('${link} select[aria-label$=" node"]').options].every(el=>!el.text.includes('IMAGE IMAGE'))`));
    }
    await cdp.evaluate(`document.querySelector('${link}').scrollIntoView({block:'center'})`);
    await shot('filled-panels');
    const geometry=await cdp.evaluate(`(()=>{const row=document.querySelector('${link}'),controls=[...row.querySelectorAll('.vz-connection-control .select-control,.vz-connection-control .text-field')].map(el=>el.getBoundingClientRect().toJSON());return {controls,chevrons:[...row.querySelectorAll('.select-control')].map(el=>{const b=el.getBoundingClientRect(),s=el.querySelector('.chevron-slot svg').getBoundingClientRect();return [s.top-b.top,b.bottom-s.bottom,b.right-s.right]}),icons:[...document.querySelectorAll('.vz-parameter-remove,.vz-catalogue-add')].filter(el=>el.getClientRects().length).map(el=>{const b=el.getBoundingClientRect(),s=el.querySelector('svg').getBoundingClientRect();return [s.left-b.left,b.right-s.right,s.top-b.top,b.bottom-s.bottom]})}})()`);
    assert(geometry.icons.every(gaps=>Math.max(...gaps)-Math.min(...gaps)<=1),JSON.stringify(geometry));
    assert(geometry.chevrons.every(gaps=>Math.max(...gaps)-Math.min(...gaps)<=1),JSON.stringify(geometry));
    if (!unknown) {assert.equal(geometry.controls.length,2);assert(Math.abs(geometry.controls[0].top-geometry.controls[1].top)<=1);assert(Math.abs(geometry.controls[0].height-geometry.controls[1].height)<=1);}
    fs.writeFileSync(`${E}/presentation-geometry.json`,JSON.stringify(geometry,null,2));
    await write('.vz-field-filter input','nothing matches');
    assert.equal(await cdp.evaluate('document.querySelectorAll(".vz-parameter").length'),7);
    assert.equal(await cdp.evaluate('document.querySelector(".vz-prefix").value+document.querySelector(".vz-suffix").value'),'');
    assert.deepEqual(errors,[]);
    console.log('PASS presentation: complete sections, full identity filter, seven kinds, no heading checkbox, exact raw typing/re-add, connection controls, symmetric icons, active filter independence');
  } finally {await cdp.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
