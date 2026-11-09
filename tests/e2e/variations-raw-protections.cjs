const assert = require('node:assert/strict');
const fs = require('node:fs');
const { addParameter } = require('./variation-add-helpers.cjs');

// Selectable consumer scenario: new raw leaves use the existing ticket/decision
// protections, with genuine held acknowledgements and no replay of typed Run.
module.exports = async ({ cdp, errors, FAKE, E, KZ, write, shot }) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  const row = name => `[data-candidate-id="92:105.${name}"]`;
  const invoke = (id, args = {}) => cdp.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const jobs = async () => (await (await fetch(FAKE + '/__test/enqueues')).json()).length;
  const open = async () => {
    await invoke('variations.open', { id: 'fake:allparams_00001_.png' });
    await cdp.poll('document.querySelectorAll(".vz-catalogue-row").length===17');
  };
  const close = async () => {
    await cdp.clickAt('.vz-close');
    if (await cdp.evaluate('!!document.querySelector(".vz-discard")')) await cdp.clickAt('.vz-discard-confirm');
    await cdp.poll('!document.querySelector(".vz-panel")');
  };
  const snapshot = () => cdp.evaluate(`({fields:[...document.querySelectorAll('.vz-panel input:not([type=file]),.vz-panel textarea,.vz-panel select')].map(el=>[el.getAttribute('aria-label'),el.value,el.checked]),files:document.querySelector('.vz-imgfilespick')===window.__rawFileInput&&[...window.__rawFileInput.files].every((file,i)=>file===window.__rawFiles[i])})`);
  const setup = async (caseName = 'newer') => {
    for (const name of ['object', 'array', 'wrapped', 'nullable', 'unknown', 'connection', 'flag', 'choice']) {
      try { await addParameter(cdp, `92:105.${name}`); }
      catch (error) { await shot('add-failure'); throw error; }
    }
    await write(row('object') + ' textarea', ' { "kept": 9007199254740993 } ');
    await write(row('array') + ' textarea', '[false, null]');
    await write(row('wrapped') + ' textarea', '{ "__value__": [true, null] }');
    await write(row('unknown') + ' textarea', '{}');
    await addParameter(cdp, '76.image');
    await cdp.evaluate(`(async()=>{const input=document.querySelector('.vz-imgfilespick'),data=new DataTransfer(),bytes=await(await fetch('/api/collections/fake/entries/flux-lora.png/bytes')).arrayBuffer();data.items.add(new File([bytes],${JSON.stringify('kept-' + caseName + '.png')},{type:'image/png'}));input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));window.__rawFileInput=input;window.__rawFiles=[...input.files]})()`);
    await write('.vz-prefix', 'raw_'); await write('.vz-suffix', '_manual_{92:105.flag}');
  };
  const hold = async () => {
    await cdp.evaluate(`(async()=>{window.__rawFetch=window.fetch;window.__rawRelease=null;window.fetch=(url,options)=>{const task=window.__rawFetch(url,options);return String(url).includes('/features/variations/run')?task.then(response=>new Promise(resolve=>window.__rawRelease=()=>resolve(response))):task};window.__rawRun=${KZ}.handles.invoke('variations.run')})()`);
    try { await cdp.poll('typeof window.__rawRelease==="function"'); }
    catch (error) { await shot('held-run-failure'); error.message += ' ' + JSON.stringify(await cdp.evaluate('({message:document.querySelector(".vz-messages").textContent,fields:[...document.querySelectorAll(".vz-candidate-row textarea")].map(el=>el.value)})')); throw error; }
  };
  const release = async () => {
    await cdp.evaluate('window.__rawRelease();window.fetch=window.__rawFetch');
    return cdp.evaluate('window.__rawRun');
  };
  const stays = async () => { await new Promise(resolve => setTimeout(resolve, 3200)); assert(await cdp.evaluate('!!document.querySelector(".vz-panel")')); };
  await cdp.evaluate("fetch('/api/collections/fake/entries/allparams_00001_.png/bytes').then(()=>true)");
  await open();
  const alignment = await cdp.evaluate(`(()=>{const box=el=>el.getBoundingClientRect();return [...document.querySelectorAll('.vz-catalogue-row')].map(row=>{const button=box(row.querySelector('button')),icon=box(row.querySelector('button span')),context=box(row.querySelector('.vz-catalogue-context'));return {id:row.dataset.catalogueId,gaps:[icon.left-button.left,button.right-icon.right,icon.top-button.top,button.bottom-icon.bottom],center:Math.abs((context.top+context.bottom-button.top-button.bottom)/2)}})})()`);
  assert(alignment.every(row => Math.max(...row.gaps) - Math.min(...row.gaps) <= 1 && row.center <= 1));
  await cdp.evaluate('document.querySelector(".vz-catalogue-add").focus()');
  await shot('catalogue-focus');
  await setup();
  // Ordered whole candidates: blank is invalid, actions preserve exact spelling.
  await cdp.clickAt(row('object') + ' .vz-candidate-add');
  await cdp.clickAt('.vz-run'); assert.equal(await jobs(), 0);
  await cdp.poll('document.querySelector(".vz-error").textContent.includes("complete JSON")');
  await shot('empty-candidate-error');
  await write(row('object') + ' .vz-candidate-entry:nth-child(2) textarea', '{}');
  await cdp.clickAt(row('object') + ' [aria-label="Move candidate 2 up"]');
  assert.equal(await cdp.evaluate(`document.querySelector('${row('object')} textarea').value`), '{}');
  await shot('ordered-json-candidates');
  await cdp.clickAt(row('object') + ' [aria-label="Move candidate 1 down"]');
  await cdp.clickAt(row('object') + ' [aria-label="Remove candidate 2"]');
  await cdp.clickAt(row('object') + ' [aria-label="Remove candidate 1"]');
  await cdp.clickAt('.vz-run'); assert.equal(await jobs(), 0);
  await cdp.poll('document.querySelector(".vz-error").textContent.includes("at least one")'); await shot('zero-json-candidates');
  await cdp.clickAt(row('object') + ' .vz-candidate-add');
  await write(row('object') + ' textarea', ' { "kept": 9007199254740993 } ');
  await cdp.clickAt(row('flag') + ' .vz-typed-options label:nth-child(2) input');
  await cdp.clickAt('.vz-run'); assert.equal(await jobs(), 0);
  await cdp.poll('document.querySelector(".vz-error").textContent.includes("at least one")');
  await cdp.evaluate(`document.querySelector('${row('flag')}').scrollIntoView({block:'center'})`); await shot('empty-boolean-error');
  await cdp.clickAt(row('flag') + ' .vz-typed-options label:nth-child(2) input');
  await cdp.evaluate(`document.querySelector('${row('choice')}').scrollIntoView({block:'center'})`); await shot('typed-option-states');
  assert.deepEqual(await cdp.evaluate(`[...document.querySelectorAll('${row('choice')} .vz-typed-options .single-line-text')].map(el=>el.textContent)`), ['false','null','0','"0"']);
  await cdp.clickAt(row('choice') + ' .vz-typed-options label:nth-child(3) input');
  await cdp.clickAt('.vz-run'); assert.equal(await jobs(), 0);
  await cdp.poll('document.querySelector(".vz-error").textContent.includes("at least one")'); await shot('empty-typed-options');
  await cdp.clickAt(row('choice') + ' .vz-typed-options label:nth-child(3) input');
  await write(row('connection') + ' input[type=text]', '');
  await cdp.clickAt('.vz-run'); assert.equal(await jobs(), 0);
  await cdp.evaluate(`document.querySelector('${row('connection')}').scrollIntoView({block:'center'})`); await shot('connection-slot-error');
  await write(row('connection') + ' input[type=text]', '1');
  await cdp.clickAt('.vz-run'); assert.equal(await jobs(), 0);
  await cdp.poll('document.querySelector(".vz-error").textContent.includes("Invalid output slot")'); await shot('known-slot-error');
  await write(row('connection') + ' input[type=text]', '0');
  await cdp.evaluate(`document.querySelector('${row('connection')} select').focus()`); await cdp.keyTrusted('ArrowDown',{vk:40});
  assert.notEqual(await cdp.evaluate(`document.querySelector('${row('connection')} select').value`), 'source'); await shot('connection-node-choice');
  await cdp.keyTrusted('ArrowUp',{vk:38}); assert.equal(await cdp.evaluate(`document.querySelector('${row('connection')} select').value`), 'source');
  await cdp.clickAt(row('connection') + ' .vz-candidate-add');
  await cdp.clickAt(row('connection') + ' [aria-label="Move candidate 2 up"]');
  await cdp.clickAt(row('connection') + ' [aria-label="Remove candidate 2"]');
  const geometry = [];
  for (const [width,height] of [[1600,1000],[1024,768],[768,600],[500,700],[360,640],[1024,360]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    for (const selector of ['.vz-field-filter input',row('connection')+' input[type=text]','.vz-run']) {
      // Public field focus uses native reveal. Run has no programmatic focus
      // intent in the product; its real keyboard navigation is Tab from Suffix.
      if (selector === '.vz-run') {
        await cdp.evaluate('document.querySelector(".vz-suffix").focus()');
        await cdp.keyTrusted('Tab', { vk: 9 });
      } else await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
      await cdp.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      assert(await cdp.evaluate(`document.activeElement.matches(${JSON.stringify(selector)})`));
      const frame = await cdp.evaluate(`(()=>{const r=document.activeElement.getBoundingClientRect(),v=document.querySelector('.vz-body-scroll').getBoundingClientRect();return {width:innerWidth,height:innerHeight,selector:${JSON.stringify(selector)},via:${JSON.stringify(selector === '.vz-run' ? 'native Tab' : 'native focus')},left:r.left,right:r.right,top:r.top,bottom:r.bottom,v:v.toJSON()}})()`);
      assert(frame.left>=frame.v.left-1&&frame.right<=frame.v.right+1&&frame.top>=frame.v.top-1&&frame.bottom<=frame.v.bottom+1,JSON.stringify(frame)); geometry.push(frame);
    }
  }
  const scrolling = await cdp.evaluate(`(()=>{const catalogue=document.querySelector('.vz-catalogue-list'),center=document.querySelector('.vz-sliders'),side=document.querySelector('.vz-sidebar-body');catalogue.scrollTop=0;center.scrollTop=0;side.scrollTop=0;center.scrollTop=200;const a=[catalogue.scrollTop,center.scrollTop,side.scrollTop];catalogue.scrollTop=200;return {a,b:[catalogue.scrollTop,center.scrollTop,side.scrollTop]}})()`);
  assert(scrolling.a[1]>0&&scrolling.a[0]===0&&scrolling.a[2]===0); assert.equal(scrolling.b[1],scrolling.a[1]); assert(scrolling.b[0]>0&&scrolling.b[2]===0);
  fs.writeFileSync(`${E}/control-geometry.json`,JSON.stringify({alignment,geometry,scrolling},null,2));
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false});
  await hold(); await write(row('object')+' textarea','{ newer unfinished');
  await cdp.clickAt(row('object')+' .checkbox'); await addParameter(cdp,'92:105.object');
  assert.equal(await cdp.evaluate(`document.querySelector('${row('object')} textarea').value`),'{ newer unfinished');
  const newer = await snapshot(); assert.equal((await release()).adopted,false); await stays(); assert.deepEqual(await snapshot(),newer);
  await cdp.clickAt('.vz-close'); await cdp.poll('!!document.querySelector(".vz-keep")'); await shot('newer-edit-discard'); await cdp.clickAt('.vz-keep'); assert.deepEqual(await snapshot(),newer);
  // Independent acknowledgement scenario: do not re-upload the prior case's
  // already accepted filename into a fake backend that rejects collisions.
  await close(); await open(); await setup('keep');
  await hold(); const kept = await snapshot(); await cdp.clickAt('.vz-close'); await cdp.poll('!!document.querySelector(".vz-keep")'); await cdp.clickAt('.vz-keep');
  assert.equal((await release()).adopted,true); await stays(); assert.deepEqual(await snapshot(),kept); await shot('keep-editing-acknowledged');
  await cdp.clickAt('.vz-close'); await cdp.poll('!document.querySelector(".vz-panel")');
  for (const mode of ['partial','uncertain']) {
    await open(); await setup(mode); const before=await snapshot(),count=await jobs();
    await cdp.evaluate(`(()=>{window.__rawFetch=window.fetch;window.__rawCalls=0;window.fetch=(url,options)=>{if(!String(url).includes('/features/variations/run'))return window.__rawFetch(url,options);window.__rawCalls++;return ${mode==='partial'?"Promise.resolve(new Response(JSON.stringify({submitted:1,total:2,errors:[{error:'partial result'}]}),{status:200}))":"Promise.reject(new Error('lost raw response'))"}}})()`);
    assert.equal((await invoke('variations.run')).adopted,false); await stays(); assert.deepEqual(await snapshot(),before);
    assert.equal(await cdp.evaluate('window.__rawCalls'),1); assert.equal(await jobs(),count);
    assert(await cdp.evaluate('document.querySelector(".vz-error").textContent.length>0')); await shot(mode+'-kept');
    await cdp.evaluate('window.fetch=window.__rawFetch'); await close();
  }
  await invoke('variations.open', { id: 'fake:flux-basic.png' }); await addParameter(cdp,'9.steps');
  const step = '[data-param-key="9.steps"] .vz-row-inc-input';
  assert(await cdp.evaluate('!!document.querySelector("[data-param-key=\\"9.steps\\"] [role=slider]")'));
  await write(step, '18446744073709551615');
  assert.equal(await cdp.evaluate('document.querySelectorAll("[data-param-key=\\"9.steps\\"] [role=slider]").length'),0);
  assert.equal(await cdp.evaluate(`document.querySelector('${step}').value`),'18446744073709551615');
  await shot('unsafe-increment-no-slider');
  await write(step, '1'); await cdp.poll('!!document.querySelector("[data-param-key=\\"9.steps\\"] [role=slider]")');
  await shot('safe-increment-slider-restored'); await close();
  assert.deepEqual(errors,[]);
  fs.writeFileSync(`${E}/protections.json`,JSON.stringify({alignment:alignment.length,focusProbes:geometry.length,scrolling,actualJobs:await jobs(),errors},null,2));
  console.log('PASS ordered JSON/connection actions, empty controls, icon gaps, 18 focus probes, independent scrolling, newer raw edit, Keep editing, partial/uncertain raw+File retention and no retries');
};
