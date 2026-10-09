// Terminal closure after submitted on/off choices, with actual captured prompts.
const assert=require('node:assert/strict');
module.exports=async({cdp,FAKE,KZ,check})=>{
  const invoke=(id,args={})=>cdp.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const type=async(selector,text)=>{await cdp.clickAt(selector);await cdp.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.select()})()`);await cdp.send('Input.insertText',{text});await cdp.poll(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(text)}`);};
  const jobs=async()=>await(await fetch(FAKE+'/__test/enqueues')).json();
  const open=async()=>{
    await cdp.evaluate(`(async()=>{await fetch('/api/collections/fake/entries/flux-controlnet.png/bytes');await ${KZ}.handles.invoke('variations.open',{id:'fake:flux-controlnet.png'})})()`);
    await cdp.poll("!!document.querySelector('.vz-textrow[data-text-id=\"CLIPTextEncode#42.text\"]')");
  };
  const textOnly=async(twoTexts=true)=>{
    await cdp.clickAt('.vz-slider-row[data-param-key="BasicScheduler.denoise"] .vz-cb');
    await cdp.clickAt('.vz-textrow[data-text-id="CLIPTextEncode#2.text"] .vz-cb');
    await type('.vz-textrow[data-text-id="CLIPTextEncode#2.text"] .vz-text-values','First {{pick}}.\n\nSecond paragraph.');
    await cdp.poll("!!document.querySelector('.vz-tpl-input')");await type('.vz-tpl-input','one; two');
    if(twoTexts){await cdp.clickAt('.vz-textrow[data-text-id="CLIPTextEncode#42.text"] .vz-cb');await type('.vz-textrow[data-text-id="CLIPTextEncode#42.text"] .vz-text-values','negative text');}
  };
  await fetch(FAKE+'/__test/activity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({captureEnqueue:true})});
  try{
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

    await open();await cdp.poll("!!document.querySelector('.vz-imgrow:not(.vz-enumrow):not(.vz-textrow) .vz-cb')");
    await cdp.clickAt('.vz-imgrow:not(.vz-enumrow):not(.vz-textrow) .vz-cb');
    await cdp.poll("!!document.querySelector('.vz-imgfile')");
    await cdp.evaluate("(()=>{const e=document.querySelector('.vz-imgfile');e.value='ref.png';e.dispatchEvent(new Event('change',{bubbles:true}))})()");
    await cdp.clickAt('.vz-enumrow[data-enum-id="BasicScheduler#9.scheduler"] .vz-imgrow-head .vz-cb');
    await cdp.clickAt('.vz-enumrow[data-enum-id="BasicScheduler#9.scheduler"] .vz-enum-opt:last-child .vz-cb');
    await cdp.clickAt('.vz-textrow[data-text-id="CLIPTextEncode#2.text"] .vz-cb');
    await type('.vz-textrow[data-text-id="CLIPTextEncode#2.text"] .vz-text-values','acknowledged text');
    assert.equal((await invoke('variations.run')).status,'submitted');
    // Previously acknowledged values are retained; only their on/off choices change.
    await cdp.clickAt('.vz-imgrow:not(.vz-enumrow):not(.vz-textrow) .vz-cb');
    await cdp.clickAt('.vz-enumrow[data-enum-id="BasicScheduler#9.scheduler"] .vz-imgrow-head .vz-cb');
    await cdp.clickAt('.vz-textrow[data-text-id="CLIPTextEncode#2.text"] .vz-cb');
    const second=(await jobs()).length;assert.equal((await invoke('variations.run')).status,'submitted');
    const numeric=(await jobs()).slice(second);assert(numeric.length>0);
    assert(numeric.every(job=>job.prompt['43'].inputs.image==='canny.png'&&job.prompt['2'].inputs.text==='a portrait, studio light'&&job.prompt['9'].inputs.scheduler==='simple'));
    await cdp.poll("!document.querySelector('.vz-panel')",6000);
    check('image/enum/text off selections after acknowledged values: only numeric jobs apply, and modal closes',true);

    await invoke('variations.open',{ids:['fake:flux-controlnet.png','fake:flux-basic.png'],bulk:true});
    await cdp.poll("!!document.querySelector('.vz-textrow[data-text-id=\"CLIPTextEncode#42.text\"]')");
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
