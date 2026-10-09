// Real edited configuration -> actual fake enqueue -> clean close, never a second Run.
const assert=require('node:assert/strict');
module.exports=async({cdp,FAKE,KZ,check})=>{
  const invoke=(id,args={})=>cdp.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const open=async(file='flux-basic.png')=>{await invoke('variations.open',{id:'fake:'+file});await cdp.poll("document.querySelectorAll('.vz-slider-row').length>0");};
  const type=async(selector,text)=>{await cdp.clickAt(selector);await cdp.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.select()})()`);await cdp.send('Input.insertText',{text});await cdp.poll(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(text)}`);};
  const enqueues=async()=>await(await fetch(FAKE+'/__test/enqueues')).json();
  const close=async()=>{
    if(!await cdp.evaluate("!!document.querySelector('.vz-discard')")) await cdp.evaluate(`(async()=>{window.__ackLeave=${KZ}.handles.invoke('variations.close');return true})()`);
    if(await cdp.evaluate("!!document.querySelector('.vz-discard')"))await cdp.clickAt('.vz-discard-confirm');
    await cdp.poll("!document.querySelector('.vz-panel')");
  };
  const dirtyClose=async()=>{await cdp.clickAt('.vz-close');await cdp.poll("!!document.querySelector('.vz-discard')");await cdp.clickAt('.vz-discard-confirm');await cdp.poll("!document.querySelector('.vz-panel')");};
  const held=async()=>{
    await cdp.evaluate(`(()=>{window.__ackFetch=window.fetch;window.__ackFinish=null;window.fetch=(url,options)=>{
      const task=window.__ackFetch(url,options);return String(url).includes('/features/variations/run')?task.then(response=>new Promise(resolve=>window.__ackFinish=()=>resolve(response))):task}})()`);
    await cdp.evaluate(`(async()=>{window.__ackRun=${KZ}.handles.invoke('variations.run');return true})()`);
    await cdp.poll("typeof window.__ackFinish==='function'");
  };
  const release=async()=>{await cdp.evaluate("window.__ackFinish();window.fetch=window.__ackFetch");return cdp.evaluate("window.__ackRun");};
  const stays=async()=>{await new Promise(resolve=>setTimeout(resolve,3200));assert(await cdp.evaluate("!!document.querySelector('.vz-panel')"));};
  await fetch(FAKE+'/__test/activity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({captureEnqueue:true})});
  try{
    await open();await type('.vz-prefix','ack-auto_');const before=(await enqueues()).length;
    assert.equal((await invoke('variations.run')).status,'submitted');
    const jobs=(await enqueues()).slice(before);assert(jobs.length>0);assert(jobs.every(job=>job.prompt && job.extra_data));
    await cdp.poll("!document.querySelector('.vz-panel')",6000);
    assert.equal((await enqueues()).length,before+jobs.length);
    check('acknowledged edited submission automatically closes without another enqueue',true);
    await open();await type('.vz-prefix','ack-manual_');assert.equal((await invoke('variations.run')).status,'submitted');
    await cdp.clickAt('.vz-close');await cdp.poll("!document.querySelector('.vz-panel')",2000);
    assert.equal(await cdp.evaluate("!!document.querySelector('.vz-discard')"),false);
    check('acknowledged edited submission manually closes without discard confirmation',true);

    await open();await type('.vz-prefix','before-held_');await held();await type('.vz-prefix','newer-edit_');
    assert.equal((await release()).status,'submitted');await stays();
    assert.equal(await cdp.evaluate("document.querySelector('.vz-prefix').value"),'newer-edit_');await dirtyClose();
    check('held genuine acknowledgement preserves newer edits and their discard guard',true);

    await open();await type('.vz-prefix','same-capture_');await held();
    await type('.vz-prefix','intermediate_');await type('.vz-prefix','same-capture_');
    await release();await stays();await dirtyClose();
    check('edit-and-revert revision fences the old acknowledgement',true);

    await open();await type('.vz-prefix','keep-editing_');await held();
    await cdp.clickAt('.vz-close');await cdp.poll("!!document.querySelector('.vz-discard')");await cdp.clickAt('.vz-keep');
    await release();await stays();await cdp.clickAt('.vz-close');await cdp.poll("!document.querySelector('.vz-panel')");
    check('Keep editing during a held Run invalidates future auto-close creation, but permits clean manual close',true);

    await open();await type('.vz-prefix','pending-decision_');await held();
    await cdp.clickAt('.vz-close');await cdp.poll("!!document.querySelector('.vz-discard')");await release();
    assert(await cdp.evaluate("!!document.querySelector('.vz-discard')"));await cdp.clickAt('.vz-keep');await stays();await dirtyClose();
    check('acknowledgement received under a pending leave decision cannot clear that protected draft',true);

    await open();await type('.vz-prefix','countdown_');await invoke('variations.run');await type('.vz-prefix','countdown-newer_');
    await stays();await dirtyClose();check('edits during the close countdown cancel it and stay dirty',true);

    await open();await type('.vz-prefix','active_');
    await cdp.clickAt('.vz-slider-row[data-param-key="BasicScheduler.steps"] .vz-cb');
    await type('.vz-slider-row[data-param-key="BasicScheduler.steps"] .vz-row-inc-input','1e');
    await cdp.clickAt('.vz-slider-row[data-param-key="BasicScheduler.steps"] .vz-cb');
    assert.equal((await invoke('variations.run')).status,'submitted');await stays();
    assert.equal(await cdp.evaluate("document.querySelector('.vz-slider-row[data-param-key=\"BasicScheduler.steps\"] .vz-row-inc-input').value"),'1e');
    await dirtyClose();check('successful active configuration never acknowledges disabled incomplete editor text',true);

    await open();await cdp.clickAt('.vz-textrow[data-text-id="CLIPTextEncode#2.text"] .vz-cb');
    await type('.vz-text-values','{{dormant}}');await cdp.poll("!!document.querySelector('.vz-tpl-input')");await type('.vz-tpl-input','one; two');
    await type('.vz-text-values','literal submitted text');assert.equal((await invoke('variations.run')).status,'submitted');
    await stays();await dirtyClose();check('dormant template values remain unsubmitted work after literal text succeeds',true);

    await open();await type('.vz-prefix','uncorrelated_');
    await cdp.evaluate(`(()=>{window.__ackFetch=window.fetch;window.fetch=(url,options)=>window.__ackFetch(url,options).then(async response=>{
      if(!String(url).includes('/features/variations/run'))return response;const data=await response.json();data.acknowledgement.requestId='foreign';return new Response(JSON.stringify(data),{status:200})})})()`);
    const count=(await enqueues()).length;await invoke('variations.run');await stays();
    assert(await cdp.evaluate("document.querySelector('.vz-error').textContent.includes('acknowledgement unavailable')"));
    assert((await enqueues()).length>count);await cdp.evaluate("window.fetch=window.__ackFetch");await dirtyClose();
    check('actual queued work with foreign acknowledgement keeps edits and reports unavailable proof without retry',true);

    await invoke('variations.open',{ids:['fake:flux-basic.png','fake:flux-lora.png'],bulk:true});await cdp.poll("document.querySelectorAll('.vz-slider-row').length>0");
    await type('.vz-prefix','all-targets_');
    await cdp.evaluate(`(()=>{window.__ackFetch=window.fetch;window.fetch=(url,options)=>window.__ackFetch(url,options).then(async response=>{
      if(!String(url).includes('/features/variations/run'))return response;const data=await response.json();if(JSON.parse(options.body).filename==='flux-lora.png')data.acknowledgement.accepted=[];
      return new Response(JSON.stringify(data),{status:200})})})()`);
    await invoke('variations.run');await stays();await cdp.evaluate("window.fetch=window.__ackFetch");await dirtyClose();
    check('one invalid captured target prevents every baseline acknowledgement in a batch',true);

    await open();await type('.vz-slider-row[data-param-key="BasicScheduler.denoise"] .vz-row-inc-input','1e-1');
    await cdp.clickAt('.vz-textrow[data-text-id="CLIPTextEncode#2.text"] .vz-cb');await type('.vz-text-values','First {{used}}.\n\nSecond {{used}}.\n');
    await cdp.poll("!!document.querySelector('.vz-tpl-input')");await type('.vz-tpl-input','cat; dog');
    const start=(await enqueues()).length;assert.equal((await invoke('variations.run')).status,'submitted');
    const templateJobs=(await enqueues()).slice(start);assert.deepEqual([...new Set(templateJobs.map(job=>job.prompt['2'].inputs.text))],['First cat.\n\nSecond cat.\n','First dog.\n\nSecond dog.\n']);
    assert.equal(await cdp.evaluate("document.querySelector('.vz-row-inc-input').value"),'1e-1');
    await cdp.clickAt('.vz-close');await cdp.poll("!document.querySelector('.vz-panel')");
    check('valid raw increment spelling and contributing multiline-template entries are acknowledged without editor normalization',true);

    await open('flux-lora.png');await cdp.clickAt('.vz-enumrow[data-enum-id="LoraLoader#20.lora_name"] .vz-imgrow-head .vz-cb');
    await cdp.clickAt('.vz-enumrow[data-enum-id="LoraLoader#20.lora_name"] .vz-enum-opt:last-child .vz-cb');
    const enumStart=(await enqueues()).length;assert.equal((await invoke('variations.run')).status,'submitted');
    const enumJobs=(await enqueues()).slice(enumStart);assert.deepEqual([...new Set(enumJobs.map(job=>job.prompt['20'].inputs.lora_name))],['detail.safetensors','other.safetensors']);
    assert(enumJobs.every(job=>job.prompt['21'].inputs.lora_name==='style.safetensors'));
    await cdp.clickAt('.vz-close');await cdp.poll("!document.querySelector('.vz-panel')");
    check('actual ordered per-node enum picks are acknowledged and permit clean close',true);

    await open('flux-controlnet.png');await cdp.poll("!!document.querySelector('.vz-imgrow:not(.vz-enumrow):not(.vz-textrow) .vz-cb')");
    await cdp.clickAt('.vz-imgrow:not(.vz-enumrow):not(.vz-textrow) .vz-cb');
    await cdp.poll("!!document.querySelector('.vz-imgfile')");
    await cdp.evaluate("(()=>{const e=document.querySelector('.vz-imgfile');e.value='ref.png';e.dispatchEvent(new Event('change',{bubbles:true}))})()");
    const newStart=(await enqueues()).length;assert.equal((await invoke('variations.run')).status,'submitted');
    assert((await enqueues()).slice(newStart).every(job=>job.prompt['43'].inputs.image==='ref.png'));
    await cdp.clickAt('.vz-close');await cdp.poll("!document.querySelector('.vz-panel')");
    check('actual selected existing input filename is acknowledged and permits clean close',true);

    await open('flux-controlnet.png');await cdp.poll("!!document.querySelector('.vz-imgrow:not(.vz-enumrow):not(.vz-textrow) .vz-cb')");await cdp.clickAt('.vz-imgrow:not(.vz-enumrow):not(.vz-textrow) .vz-cb');
    await cdp.evaluate("(()=>{const mode=document.querySelector('.vz-imgmode');mode.value='files';mode.dispatchEvent(new Event('change',{bubbles:true}))})()");
    await cdp.poll("!!document.querySelector('.vz-imgfilespick')");
    await cdp.evaluate("(()=>{const e=document.querySelector('.vz-imgfilespick'),data=new DataTransfer();data.items.add(new File(['a'],'ack-a.png',{type:'image/png'}));data.items.add(new File(['b'],'ack-b.png',{type:'image/png'}));e.files=data.files;e.dispatchEvent(new Event('change',{bubbles:true}));window.__ackFiles=[...e.files];window.__ackInput=e})()");
    const fileStart=(await enqueues()).length;assert.equal((await invoke('variations.run')).status,'submitted');
    const fileJobs=(await enqueues()).slice(fileStart);assert.deepEqual([...new Set(fileJobs.map(job=>job.prompt['43'].inputs.image))],['ack-a.png','ack-b.png']);
    assert(await cdp.evaluate("document.querySelector('.vz-imgfilespick')===window.__ackInput && [...window.__ackInput.files].every((file,i)=>file===window.__ackFiles[i])"));
    await cdp.clickAt('.vz-close');await cdp.poll("!document.querySelector('.vz-panel')");
    check('actual validated uploads and accepted LoadImage writes acknowledge ordered native Files without replacing them',true);
  }finally{
    await cdp.evaluate("if(window.__ackFetch)window.fetch=window.__ackFetch");
    if(await cdp.evaluate("!!document.querySelector('.vz-panel')"))await close();
    await fetch(FAKE+'/__test/activity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({captureEnqueue:false})});
  }
};
