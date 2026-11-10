const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { addParameter } = require('./variation-add-helpers.cjs');
const { captureReviewRegions } = require('./variation-capture-helpers.cjs');
const ENGINE = process.env.E2E_ENGINE, FAKE = process.env.E2E_FAKE, E = process.env.E2E_EVIDENCE;
const KZ = `(await import('/store/instance.js')).appStore`;
(async () => {
  const cdp = await CDP.launch(19454, {windowSize:'1600,1000'}), errors = await collectPageErrors(cdp);
  const shot = async name => { const {data} = await cdp.send('Page.captureScreenshot',{format:'png'}); fs.writeFileSync(`${E}/${name}.png`,Buffer.from(data,'base64')); await captureReviewRegions(cdp,E,name); };
  const write = async (selector,text) => {await cdp.clickAt(selector);await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`);await cdp.send('Input.insertText',{text});};
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false});
    if (process.env.E2E_VARIATIONS_CASE === 'catalogue-roots') {
      const name='catalogue-same.png', roots=['input','output','temp'], colors=[[200,40,40,255],[40,160,60,255],[40,70,200,255]];
      const item=i=>({name,fixture:'flux-basic.png',width:96,height:64,color:colors[i]});
      const graph=Object.fromEntries(roots.map((root,i)=>[String(11+i),{class_type:'LoadImage',inputs:{image:name+(root==='input'?'':` [${root}]`)},_meta:{title:'Repeated image'}}]));
      const fullText='  complete current first line\n\nsecond line with trailing spaces  ';
      graph['14']={class_type:'SaveImage',inputs:{images:['13',0],filename_prefix:fullText}};
      assert((await fetch(FAKE+'/__test/activity',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({reset:true,publishInputs:[item(0)],publishTemps:[item(2)],publish:[item(1),{name:'catalogue-roots.png',fixture:'flux-lora.png',graph,width:640,height:480}]})})).ok);
      await cdp.goto(ENGINE+'/#fake#catalogue-roots.png');
      await cdp.poll('!!document.querySelector(".card .variations")',20000);
      await cdp.evaluate(`(async()=>{await fetch('/api/collections/fake/entries/catalogue-roots.png/bytes');return ${KZ}.handles.invoke('variations.open',{id:'fake:catalogue-roots.png'})})()`);
      await cdp.poll('document.querySelectorAll(".vz-catalogue-picture").length===3');
      const pixels=[];
      for (const [i,root] of roots.entries()) {
        const selector=`[data-catalogue-id="${11+i}.image"]`;
        await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
        await cdp.poll(`document.querySelector(${JSON.stringify(selector+' img')})?.naturalWidth>0`);
        const actual=await cdp.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}),img=el.querySelector('img'),c=document.createElement('canvas');c.width=c.height=1;const x=c.getContext('2d');x.drawImage(img,0,0,1,1);return {pixels:[...x.getImageData(0,0,1,1).data],src:img.currentSrc,hint:el.querySelector('.vz-catalogue-picture').title,aria:el.querySelector('[role=img]').getAttribute('aria-label'),title:el.querySelector('.vz-catalogue-node-name').textContent}})()`);
        assert.deepEqual(actual.pixels,colors[i]);assert.equal(actual.hint,`${name} (${root})`);assert.equal(actual.aria,actual.hint);assert.equal(actual.title,'Repeated image');
        assert.equal(new URL(actual.src).searchParams.get('kind')??'output',root);pixels.push({root,...actual});
      }
      assert.equal(await cdp.evaluate('document.querySelector("[data-catalogue-id=\\"14.filename_prefix\\"] .vz-catalogue-current").title'),fullText);
      fs.writeFileSync(`${E}/catalogue-root-pixels.json`,JSON.stringify({pixels,fullText},null,2));
      await cdp.evaluate('document.querySelector(".vz-catalogue-list").scrollTop=0');await shot('catalogue-roots');
      assert.deepEqual(errors,[]);console.log('PASS catalogue same-name input/output/temp decoded RGBA, explicit root, repeated node cards and full image hints');return;
    }
    if (process.env.E2E_VARIATIONS_CASE === 'real') {
      await cdp.goto(ENGINE + '/#fake#flux-controlnet.png');
      await cdp.poll('!!document.querySelector(".card .variations")',20000);
      await cdp.evaluate(`(async()=>{await fetch('/api/collections/fake/entries/flux-controlnet.png/bytes');return ${KZ}.handles.invoke('variations.open',{id:'fake:flux-controlnet.png'})})()`);
      await cdp.poll('document.querySelectorAll(".vz-catalogue-row").length>10');
      assert.equal(await cdp.evaluate('document.querySelectorAll(".vz-catalogue-section-name,.vz-catalogue-node").length'),0);
      assert(await cdp.evaluate('(()=>{const ids=[...document.querySelectorAll(".vz-catalogue-row")].map(el=>el.dataset.catalogueId);return ids.indexOf("9.denoise")<ids.indexOf("9.scheduler")})()'));
      assert(await cdp.evaluate('[...document.querySelectorAll(".vz-catalogue-current")].every(el=>getComputedStyle(el).color!==getComputedStyle(el.parentElement.querySelector(".vz-catalogue-name")).color)'));
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
      console.log('PASS real graph: flat cards, denoise priority, four native editor kinds, catalogue accent and unchanged center value roles');
      return;
    }
    await cdp.goto(ENGINE + '/#fake#allparams_00001_.png');
    await cdp.poll('!!document.querySelector(".card .variations")',20000);
    await cdp.evaluate(`(async()=>{await fetch('/api/collections/fake/entries/allparams_00001_.png/bytes');return ${KZ}.handles.invoke('variations.open',{id:'fake:allparams_00001_.png'})})()`);
    await cdp.poll('document.querySelectorAll(".vz-catalogue-row").length===17');
    assert.equal(await cdp.evaluate('document.querySelectorAll(".vz-catalogue-section-name,.vz-catalogue-node").length'),0);
    const cards=await cdp.evaluate(`(()=>{const p=document.querySelector('.vz-panel'),token=name=>{const s=document.createElement('span');s.style.color='var('+name+')';p.append(s);const c=getComputedStyle(s).color;s.remove();return c};return [...document.querySelectorAll('.vz-catalogue-row')].map(el=>{const node=el.querySelector('.vz-catalogue-node-name'),name=el.querySelector('.vz-catalogue-name'),value=el.querySelector('.vz-catalogue-current'),s=getComputedStyle(el);return {id:el.dataset.catalogueId,node:node.textContent,borders:[s.borderTopWidth,s.borderRightWidth,s.borderBottomWidth,s.borderLeftWidth],roles:getComputedStyle(node).color===token('--foreground-mid')&&getComputedStyle(name).color===token('--foreground')&&(!value||getComputedStyle(value).color===token('--secondary')),value:value?.textContent,hover:value?.title,nowrap:[node,name,value].filter(Boolean).every(x=>getComputedStyle(x).whiteSpace==='nowrap')}})})()`);
    assert(cards.every(c=>c.borders.every(b=>b==='1px')&&c.roles&&c.nowrap&&!/#\d/.test(c.node)));
    assert.equal(cards.find(c=>c.id==='92:105.seed').hover,'18446744073709551615');
    assert(cards.filter(c=>c.id.startsWith('92:10')).length>1);
    assert(cards.every(c=>c.value===undefined||c.hover===c.value));
    fs.writeFileSync(`${E}/catalogue-cards.json`,JSON.stringify(cards,null,2));
    assert.equal(await cdp.evaluate('document.querySelectorAll(".vz-parameter").length'),0);
    assert(await cdp.evaluate('[...document.querySelectorAll(".vz-catalogue-add")].every(el=>el.querySelector("svg")&&!el.textContent.includes("->"))'));
    await shot('catalogue');
    const layouts=[];
    for(const [width,height] of [[1600,1000],[1024,768],[768,600],[500,700],[360,640],[1024,360]]){
      await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      await cdp.evaluate('document.querySelector(".vz-suffix").focus()');await cdp.keyTrusted('Tab',{vk:9});
      await cdp.poll('document.activeElement.matches(".vz-run")');
      const g=await cdp.evaluate(`(()=>{const r=s=>document.querySelector(s).getBoundingClientRect(),v=r('.vz-body-scroll'),c=r('.vz-catalogue'),m=r('.vz-left'),s=r('.vz-right'),b=r('.vz-run');return {width:innerWidth,height:innerHeight,tracks:c.right<m.left&&m.right<s.left,run:b.left>=v.left-1&&b.right<=v.right+1&&b.bottom<=v.bottom+1&&b.top>=v.top,nowrap:[...document.querySelectorAll('.vz-catalogue-context .single-line-text')].every(el=>getComputedStyle(el).whiteSpace==='nowrap'),overflow:document.querySelector('.vz-body-scroll').scrollWidth-document.querySelector('.vz-body-scroll').clientWidth}})()`);
      assert(g.tracks&&g.run&&g.nowrap);if(width>=1024)assert(g.overflow<=1);layouts.push(g);await shot(`cards-${width}x${height}`);
    }
    fs.writeFileSync(`${E}/catalogue-layouts.json`,JSON.stringify(layouts,null,2));
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false});await cdp.evaluate('document.querySelector(".vz-body-scroll").scrollLeft=0');
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
    console.log('PASS presentation: flat bordered cards, exact full hover values, palette roles, six layouts, full identity filter, seven kinds, raw/File re-add, connection controls, symmetric icons, active filter independence');
  } finally {await cdp.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
