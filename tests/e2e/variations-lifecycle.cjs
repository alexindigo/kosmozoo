// Contract consumers: metadata is not editable work, and effects retain one origin.
const assert=require('node:assert/strict');
module.exports=async({cdp,ENGINE,FAKE,KZ,check})=>{
  const invoke=(id,args={})=>cdp.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const http=async(base,path,method='GET',body)=>{const r=await fetch(base+path,{method,headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});assert(r.ok,`${path}: ${r.status}`);return r.json()};
  const type=async(selector,text)=>{await cdp.clickAt(selector);await cdp.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.select()})()`);await cdp.send('Input.insertText',{text});await cdp.poll(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(text)}`)};
  const dismiss=async()=>{if(!await cdp.evaluate("!!document.querySelector('.vz-panel')"))return;await cdp.evaluate(`(async()=>{window.__lifecycleLeave=${KZ}.handles.invoke('variations.close');return true})()`);if(await cdp.evaluate("!!document.querySelector('.vz-discard')"))await cdp.clickAt('.vz-discard-confirm');await cdp.poll("!document.querySelector('.vz-panel')")};
  const OTHER='http://'+await cdp.evaluate(`(async()=>${KZ}.state.hosts.another.address)()`);
  let alias=false;
  await http(FAKE,'/__test/activity','POST',{captureEnqueue:true});
  try{
    await cdp.evaluate("(async()=>{await fetch('/api/collections/fake/entries/flux-controlnet.png/bytes')})()");
    await cdp.evaluate(`(()=>{window.__lifecycleFetch=window.fetch;window.__inputs=null;window.__finish=null;window.fetch=async(url,options)=>{
      if(String(url).includes('/entries?kind=input'))return new Promise(resolve=>window.__inputs=()=>window.__lifecycleFetch(url,options).then(resolve));
      const response=await window.__lifecycleFetch(url,options);if(String(url).includes('/features/variations/run'))return new Promise(resolve=>window.__finish=()=>resolve(response));return response}})()`);
    await invoke('variations.open',{id:'fake:flux-controlnet.png'});
    await cdp.poll("document.querySelectorAll('.vz-slider-row').length>0&&typeof window.__inputs==='function'");
    await type('.vz-prefix','lifecycle-clean-defaults_');
    const before=(await http(FAKE,'/__test/enqueues')).length;
    await cdp.evaluate(`(async()=>{window.__lifecycleRun=${KZ}.handles.invoke('variations.run');return true})()`);
    await cdp.poll("typeof window.__finish==='function'");await cdp.evaluate('window.__inputs()');
    await cdp.poll("!!document.querySelector('.vz-imgrow:not(.vz-enumrow):not(.vz-textrow) .vz-cb')");
    await cdp.evaluate('window.__finish();window.fetch=window.__lifecycleFetch');
    assert.equal((await cdp.evaluate('window.__lifecycleRun')).status,'submitted');
    await cdp.poll("!document.querySelector('.vz-panel')",6000);assert((await http(FAKE,'/__test/enqueues')).length>before);
    check('lifecycle: actual submitted work closes after clean late input defaults, without a synthetic edit or discard',true);

    await invoke('variations.open',{id:'fake:flux-controlnet.png'});await cdp.poll("!!document.querySelector('.vz-imgrow:not(.vz-enumrow):not(.vz-textrow) .vz-cb')");
    await type('.vz-slider-row[data-param-key="9.denoise"] .vz-row-inc-input','1e-1');
    await cdp.clickAt('.vz-slider-row[data-param-key="9.denoise"] .noUi-handle[data-handle="0"]');await cdp.keyTrusted('ArrowRight',{vk:39});
    await cdp.clickAt('.vz-slider-row[data-param-key="9.denoise"] .noUi-handle[data-handle="1"]');await cdp.keyTrusted('ArrowLeft',{vk:37});
    await cdp.clickAt('.vz-imgrow:not(.vz-enumrow):not(.vz-textrow) .vz-cb');
    await cdp.evaluate("(()=>{const e=document.querySelector('.vz-imgmode');e.value='files';e.dispatchEvent(new Event('change',{bubbles:true}))})()");await cdp.poll("!!document.querySelector('.vz-imgfilespick')");
    await cdp.evaluate("(()=>{const e=document.querySelector('.vz-imgfilespick'),dt=new DataTransfer();dt.items.add(new File(['a'],'lifecycle-combined-a.png',{type:'image/png'}));dt.items.add(new File(['b'],'lifecycle-combined-b.png',{type:'image/png'}));e.files=dt.files;e.dispatchEvent(new Event('change',{bubbles:true}));window.__combinedInput=e;window.__combinedFiles=[...e.files]})()");
    await cdp.clickAt('.vz-enumrow[data-enum-id="9.scheduler"] .vz-imgrow-head .vz-cb');await cdp.clickAt('.vz-enumrow[data-enum-id="9.scheduler"] .vz-enum-opt:last-child .vz-cb');
    await cdp.clickAt('.vz-textrow[data-text-id="2.text"] .vz-cb');await type('.vz-textrow[data-text-id="2.text"] .vz-text-values','  First {{used}}.\n\nSecond {{used}}.\n');
    await cdp.poll("!!document.querySelector('.vz-tpl-input')");await type('.vz-tpl-input','cat; dog');await type('.vz-prefix','combined_');await type('.vz-suffix','_result');
    const combinedStart=(await http(FAKE,'/__test/enqueues')).length,combined=await invoke('variations.run');assert.equal(combined.status,'submitted');assert.equal(combined.adopted,true);
    const combinedJobs=(await http(FAKE,'/__test/enqueues')).slice(combinedStart);assert.equal(combinedJobs.length,16);
    assert.deepEqual([...new Set(combinedJobs.map(job=>job.prompt['43'].inputs.image))],['lifecycle-combined-a.png','lifecycle-combined-b.png']);
    assert.deepEqual([...new Set(combinedJobs.map(job=>job.prompt['2'].inputs.text))],['  First cat.\n\nSecond cat.\n','  First dog.\n\nSecond dog.\n']);
    assert.deepEqual([...new Set(combinedJobs.map(job=>job.prompt['9'].inputs.scheduler))],['simple','exponential']);
    assert(await cdp.evaluate("document.querySelector('.vz-imgfilespick')===window.__combinedInput&&[...window.__combinedInput.files].every((file,index)=>file===window.__combinedFiles[index])"));
    assert.equal(await cdp.evaluate("document.querySelector('.vz-slider-row[data-param-key=\"9.denoise\"] .vz-row-inc-input').value"),'1e-1');
    await cdp.poll("!document.querySelector('.vz-panel')",6000);check('lifecycle: one combined numeric/File/enum/multiline-template/naming configuration reaches 16 exact graphs and clean closure',true);

    // Reconstruct this known fixture's graph through its retained history/PNG source.
    const history=await http(FAKE,'/api/history');
    const item=Object.values(history).find(entry=>entry.outputs?.['9']?.images?.some(image=>image.filename==='flux-controlnet.png'));
    assert(item);const graph=structuredClone(item.prompt[2]);graph['2'].inputs.text='a|b';graph['42'].inputs.text='c';
    await http(FAKE,'/__test/activity','POST',{publish:[{name:'lifecycle-tuple.png',fixture:'flux-controlnet.png',graph,mtime:2100000000}]});
    await cdp.evaluate("(async()=>{await fetch('/api/collections/fake/entries/lifecycle-tuple.png/bytes')})()");
    await invoke('variations.open',{id:'fake:lifecycle-tuple.png'});await cdp.poll("!!document.querySelector('.vz-textrow[data-text-id=\"42.text\"]')");
    await cdp.clickAt('.vz-slider-row[data-param-key="9.denoise"] .vz-cb');
    for(const id of ['2.text','42.text'])await cdp.clickAt(`.vz-textrow[data-text-id="${id}"] .vz-cb`);
    await type('.vz-textrow[data-text-id="2.text"] .vz-text-values','a');await type('.vz-textrow[data-text-id="42.text"] .vz-text-values','b|c');
    await cdp.poll("document.querySelector('.vz-count').textContent==='1'");const tupleStart=(await http(FAKE,'/__test/enqueues')).length;
    assert.equal((await invoke('variations.run')).submitted,1);
    const tupleJobs=(await http(FAKE,'/__test/enqueues')).slice(tupleStart);assert.equal(tupleJobs.length,1);assert.equal(tupleJobs[0].prompt['2'].inputs.text,'a');assert.equal(tupleJobs[0].prompt['42'].inputs.text,'b|c');
    await cdp.poll("!document.querySelector('.vz-panel')",6000);check('lifecycle: distinct arbitrary-text tuples count once, reach the actual backend unchanged, and close',true);

    const address=new URL(FAKE).host,otherAddress=new URL(OTHER).host;
    await http(ENGINE,'/api/collections','POST',{name:'lifecycle-owner',address});alias=true;
    await cdp.poll(`(async()=>${KZ}.state.hosts['lifecycle-owner']?.address===${JSON.stringify(address)})()`);
    await cdp.evaluate("(async()=>{await fetch('/api/collections/lifecycle-owner/entries/flux-controlnet.png/bytes')})()");
    await invoke('variations.open',{id:'lifecycle-owner:flux-controlnet.png'});await cdp.poll("!!document.querySelector('.vz-imgrow:not(.vz-enumrow):not(.vz-textrow) .vz-cb')");
    await cdp.clickAt('.vz-imgrow:not(.vz-enumrow):not(.vz-textrow) .vz-cb');
    await cdp.evaluate("(()=>{const mode=document.querySelector('.vz-imgmode');mode.value='files';mode.dispatchEvent(new Event('change',{bubbles:true}))})()");
    await cdp.poll("!!document.querySelector('.vz-imgfilespick')");
    await cdp.evaluate("(()=>{const e=document.querySelector('.vz-imgfilespick'),dt=new DataTransfer();dt.items.add(new File(['origin-A'],'lifecycle-handoff.png',{type:'image/png'}));e.files=dt.files;e.dispatchEvent(new Event('change',{bubbles:true}));window.__lifecycleInput=e;window.__lifecycleFiles=[...e.files]})()");
    const form=new FormData();form.append('image',new Blob(['origin-B']),'lifecycle-handoff.png');assert((await fetch(OTHER+'/api/upload/image',{method:'POST',body:form})).ok);
    await http(OTHER,'/__test/activity','POST',{captureEnqueue:true});const replacementStart=(await http(OTHER,'/__test/enqueues')).length;
    await cdp.evaluate(`(()=>{window.__lifecycleFetch=window.fetch;window.__uploaded=null;window.fetch=async(url,options)=>{const response=await window.__lifecycleFetch(url,options);
      if(options?.body instanceof FormData&&String(url).includes('/collections/lifecycle-owner/entries'))return new Promise(resolve=>window.__uploaded=()=>resolve(response));return response}})()`);
    await cdp.evaluate(`(async()=>{window.__lifecycleRun=${KZ}.handles.invoke('variations.run');return true})()`);await cdp.poll("typeof window.__uploaded==='function'");
    await http(ENGINE,'/api/collections/lifecycle-owner','DELETE');alias=false;
    await http(ENGINE,'/api/collections','POST',{name:'lifecycle-owner',address:otherAddress});alias=true;
    await cdp.poll(`(async()=>${KZ}.state.hosts['lifecycle-owner']?.address===${JSON.stringify(otherAddress)})()`);
    await cdp.evaluate('window.__uploaded();window.fetch=window.__lifecycleFetch');assert.equal((await cdp.evaluate('window.__lifecycleRun')).status,'stale');
    assert.equal((await http(OTHER,'/__test/enqueues')).length,replacementStart);
    assert.equal(await(await fetch(OTHER+'/api/view?type=input&filename=lifecycle-handoff.png')).text(),'origin-B');
    assert(await cdp.evaluate("!!document.querySelector('.vz-panel')&&document.querySelector('.vz-imgfilespick')===window.__lifecycleInput&&[...window.__lifecycleInput.files].every((file,index)=>file===window.__lifecycleFiles[index])"));
    assert(await cdp.evaluate("document.querySelector('.vz-error').textContent.includes('origin changed')"));
    await dismiss();check('lifecycle: source replacement after actual upload cannot dispatch on the replacement and preserves exact File/widget identity',true);
  }finally{
    await cdp.evaluate('if(window.__lifecycleFetch)window.fetch=window.__lifecycleFetch');await dismiss();
    if(alias)await http(ENGINE,'/api/collections/lifecycle-owner','DELETE');
    await http(FAKE,'/__test/activity','POST',{captureEnqueue:false});await http(OTHER,'/__test/activity','POST',{captureEnqueue:false});
  }
};
