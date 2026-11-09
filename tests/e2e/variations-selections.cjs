// Terminal closure after submitted on/off choices, with actual captured prompts.
const assert=require('node:assert/strict');
const { pickInput } = require('./image-picker-helpers.cjs');
const { freshRecipe } = require('./recipe-helpers.cjs');
const { addParameter } = require('./variation-add-helpers.cjs');
const typeText=async(cdp,selector,text)=>{await cdp.clickAt(selector);await cdp.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.select()})()`);await cdp.send('Input.insertText',{text});await cdp.poll(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(text)}`);};
const inputControl='.vz-imgrow:not(.vz-enumrow):not(.vz-textrow) .checkbox';
// This setup operates on ControlNet graphs. Its numeric/text rows can mount
// before the independently fetched input row, which inserts above them. Own
// complete control readiness before measuring any trusted pointer target.
const selectionSetup=async(cdp,twoTexts=true)=>{
  await cdp.poll(`!!document.querySelector('[data-catalogue-id="43.image"]')`);
  assert.equal(await cdp.evaluate(`!!document.querySelector('[data-param-key="9.denoise"]')`),false);
  await addParameter(cdp,'2.text');
  const type=(selector,text)=>typeText(cdp,selector,text);
  await type('.vz-textrow[data-text-id="2.text"] .vz-text-values','First {{pick}}.\n\nSecond paragraph.');
  await cdp.poll("!!document.querySelector('.vz-tpl-input')");await type('.vz-tpl-input','one; two');
  if(twoTexts){await addParameter(cdp,'42.text');await type('.vz-textrow[data-text-id="42.text"] .vz-text-values','negative text');}
};
module.exports=async({cdp,FAKE,KZ,check})=>{
  const invoke=(id,args={})=>cdp.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const type=(selector,text)=>typeText(cdp,selector,text);
  const jobs=async()=>await(await fetch(FAKE+'/__test/enqueues')).json();
  const open=async()=>{
    await cdp.evaluate(`(async()=>{await fetch('/api/collections/fake/entries/flux-controlnet.png/bytes');await ${KZ}.handles.invoke('variations.open',{id:'fake:flux-controlnet.png'})})()`);
    await cdp.poll("!!document.querySelector('[data-catalogue-id=\"42.text\"]')");
    await freshRecipe(cdp);
  };
  const textOnly=(twoTexts=true)=>selectionSetup(cdp,twoTexts);
  await fetch(FAKE+'/__test/activity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({captureEnqueue:true})});
  try{
    // Establish the default-state fixture through an ordinary fresh opening.
    await open();await invoke('variations.close');await cdp.poll("!document.querySelector('.vz-panel')");
    for(const [name,args,twoTexts] of [
      ['single',{id:'fake:flux-controlnet.png'},true],
      ['reopened',{id:'fake:flux-controlnet.png'},true],
      ['batch',{ids:['fake:flux-controlnet.png','fake:flux-basic.png'],bulk:true},false],
    ]){
      await cdp.evaluate(`(()=>{window.__selectionFetch=window.fetch;window.__selectionRelease=null;window.fetch=async(url,options)=>{const response=await window.__selectionFetch(url,options);if(!String(url).includes('/entries?kind=input'))return response;return new Promise(resolve=>window.__selectionRelease=()=>resolve(response))}})()`);
      let task,setup='pending';const beforeReadyJobs=(await jobs()).length;
      try{
        await cdp.evaluate(`(async()=>{await fetch('/api/collections/fake/entries/flux-controlnet.png/bytes');await ${KZ}.handles.invoke('variations.open',${JSON.stringify(args)})})()`);
        await cdp.poll(`!!document.querySelector('[data-catalogue-id="42.text"]')&&typeof window.__selectionRelease==='function'`);
        task=textOnly(twoTexts).then(()=>{setup='complete'},error=>{setup='failed';throw error});
        assert.equal(await cdp.evaluate(`!!document.querySelector(${JSON.stringify(inputControl)})`),false);
        await task; assert.equal(setup,'complete');
        assert.equal(await cdp.evaluate(`!!document.querySelector('[data-param-key="9.denoise"]')`),false);
        assert.equal((await jobs()).length,beforeReadyJobs);
        await cdp.evaluate('window.__selectionRelease()');await task;
        assert.equal(setup,'complete');
        assert.equal(await cdp.evaluate(`!!document.querySelector('[data-param-key="9.denoise"]')`),false);
        assert.equal((await jobs()).length,beforeReadyJobs);
        check(`selection setup owns late input layout: ${name}, trusted numeric-off and no submissions`,true);
      }finally{
        await cdp.evaluate('window.__selectionRelease?.();window.fetch=window.__selectionFetch');await task;
        await cdp.evaluate(`(async()=>{window.__selectionReadyLeave=${KZ}.handles.invoke('variations.close');return true})()`);
        if(await cdp.evaluate("!!document.querySelector('.vz-discard')"))await cdp.clickAt('.vz-discard-confirm');
        await cdp.poll("!document.querySelector('.vz-panel')");
      }
    }
    await open();await textOnly();const before=(await jobs()).length;
    const result=await invoke('variations.run');assert.equal(result.status,'submitted');assert.equal(result.submitted,2);
    const submitted=(await jobs()).slice(before);assert.equal(submitted.length,2);
    assert.deepEqual(submitted.map(job=>job.prompt['2'].inputs.text),['First one.\n\nSecond paragraph.','First two.\n\nSecond paragraph.']);
    assert(submitted.every(job=>job.prompt['42'].inputs.text==='negative text'&&job.prompt['9'].inputs.denoise===1));
    await cdp.poll("!document.querySelector('.vz-panel')",6000);assert.equal((await jobs()).length,before+2);
    check('numeric-off + two submitted text axes: actual 2/2 jobs, automatic modal closure, no extra submission',true);

    await open();await textOnly();assert.equal((await invoke('variations.run')).submitted,2);
    await cdp.clickAt('.vz-close');await cdp.poll("!document.querySelector('.vz-panel')",2000);
    assert.equal(await cdp.evaluate("!!document.querySelector('.vz-discard')"),false);
    check('numeric-off + two submitted text axes: immediate manual close has no discard decision',true);

    await open();await addParameter(cdp,'9.denoise');await addParameter(cdp,'43.image');
    await pickInput(cdp, 'ref.png');
    await addParameter(cdp,'9.scheduler');
    await cdp.clickAt('.vz-enumrow[data-enum-id="9.scheduler"] .vz-enum-opt:last-child .checkbox');
    await addParameter(cdp,'2.text');
    await type('.vz-textrow[data-text-id="2.text"] .vz-text-values','acknowledged text');
    assert.equal((await invoke('variations.run')).status,'submitted');
    // Previously acknowledged values are retained; only their on/off choices change.
    await cdp.clickAt('.vz-imgrow:not(.vz-enumrow):not(.vz-textrow) .checkbox');
    await cdp.clickAt('.vz-enumrow[data-enum-id="9.scheduler"] .vz-imgrow-head .checkbox');
    await cdp.clickAt('.vz-textrow[data-text-id="2.text"] .checkbox');
    const second=(await jobs()).length;assert.equal((await invoke('variations.run')).status,'submitted');
    const numeric=(await jobs()).slice(second);assert(numeric.length>0);
    assert(numeric.every(job=>job.prompt['43'].inputs.image==='canny.png'&&job.prompt['2'].inputs.text==='a portrait, studio light'&&job.prompt['9'].inputs.scheduler==='simple'));
    await cdp.poll("!document.querySelector('.vz-panel')",6000);
    check('image/enum/text off selections after acknowledged values: only numeric jobs apply, and modal closes',true);

    await invoke('variations.open',{ids:['fake:flux-controlnet.png','fake:flux-basic.png'],bulk:true});
    await cdp.poll("!!document.querySelector('[data-catalogue-id=\"42.text\"]')");
    await textOnly(false);const batchBefore=(await jobs()).length, batch=await invoke('variations.run');
    assert.equal(batch.status,'submitted');assert.equal(batch.submitted,4);assert.equal((await jobs()).length,batchBefore+4);
    await cdp.poll("!document.querySelector('.vz-panel')",6000);
    check('text-only batch: selections absent from one graph still remain off, all four jobs acknowledged, modal closes',true);
  }finally{
    await fetch(FAKE+'/__test/activity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({captureEnqueue:false})});
    if(await cdp.evaluate("!!document.querySelector('.vz-panel')")){
      await cdp.evaluate(`(async()=>{window.__selectionLeave=${KZ}.handles.invoke('variations.close');return true})()`);
      if(await cdp.evaluate("!!document.querySelector('.vz-discard')"))await cdp.clickAt('.vz-discard-confirm');
      await cdp.poll("!document.querySelector('.vz-panel')");
    }
  }
};
