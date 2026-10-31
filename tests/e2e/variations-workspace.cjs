// End consumers: exact fake prompts, automatic close, recovered controls and the
// same native Files delivered to freshly mounted thumbnail object-URL consumers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { workPath } = require('./paths.cjs');
module.exports = async ({ cdp, ENGINE, FAKE, KZ, check }) => {
  const invoke = (id,args={}) => cdp.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const http = async (base,path,method='GET',body) => {
    const response = await fetch(base+path,{method,headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
    assert(response.ok,`${path}: ${response.status}`); return response.json();
  };
  const jobs = () => http(FAKE,'/__test/enqueues');
  const open = async (host='fake') => { await invoke('variations.open',{id:`${host}:recipe_00001_.png`}); await cdp.poll("document.querySelectorAll('.vz-slider-row').length>0||!!document.querySelector('.vz-retained-values')"); };
  const close = async () => { await cdp.clickAt('.vz-close'); await cdp.poll("!document.querySelector('.vz-panel')"); };
  const type = async (selector,text) => {
    await cdp.clickAt(selector); await cdp.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.select()})()`);
    await cdp.send('Input.insertText',{text}); await cdp.poll(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(text)}`);
  };
  const capture = async name => { const shot = await cdp.send('Page.captureScreenshot',{format:'png'}); fs.mkdirSync(workPath('artifacts'),{recursive:true}); fs.writeFileSync(workPath('artifacts',name+'.png'),Buffer.from(shot.data,'base64')); };
  const fixedSummary = async (expectOverflow=false) => {
    const geometry=await cdp.evaluate(`(()=>{const column=document.querySelector('.vz-right'),sidebar=column.getBoundingClientRect(),run=document.querySelector('.vz-run').getBoundingClientRect(),title=document.querySelector('.vz-title'),panel=document.querySelector('.vz-panel').getBoundingClientRect(),left=document.querySelector('.vz-left').getBoundingClientRect(),messages=document.querySelector('.vz-messages'),body=column.querySelector('.vz-sidebar-body');return{contained:[...column.children].every(element=>{const box=element.getBoundingClientRect();return box.top>=sidebar.top-1&&box.bottom<=sidebar.bottom+1}),unclipped:[...column.querySelectorAll('.single-line-text')].every(element=>element.scrollHeight<=element.clientHeight+1),title:title.scrollHeight<=title.clientHeight+1,anchored:Math.abs(run.bottom-sidebar.bottom)<1,withinDialog:sidebar.top>=panel.top&&sidebar.bottom<=panel.bottom&&sidebar.right<=panel.right,sameRow:Math.abs(left.top-sidebar.top)<1&&Math.abs(left.bottom-sidebar.bottom)<1,otherRowsFit:[...column.children].filter(element=>element!==messages&&element!==body).every(element=>element.scrollHeight<=element.clientHeight+1),intrinsicBodyRows:[...body.children].every(element=>element.scrollHeight<=element.clientHeight+1),ownedBody:body.clientHeight>0&&getComputedStyle(body).overflowY==='auto',oneMessage:column.querySelectorAll('.vz-messages').length===1,hasMessage:!!messages.textContent.trim(),messageHeight:messages.clientHeight,messageScroll:messages.scrollHeight,messageOverflow:getComputedStyle(messages).overflowY,sidebarHeight:sidebar.height,messageAbove:Math.abs(run.top-messages.getBoundingClientRect().bottom-10)<1}})()`);
    const rows=await cdp.evaluate("[...document.querySelectorAll('.vz-right .single-line-text')].map(element=>({class:element.className,text:element.textContent,height:element.clientHeight,scroll:element.scrollHeight,line:getComputedStyle(element).lineHeight,shrink:getComputedStyle(element).flexShrink}))");
    assert(geometry.contained&&geometry.unclipped&&geometry.title&&geometry.anchored,JSON.stringify({geometry,rows}));
    const shell=await cdp.evaluate(`(()=>{const panel=document.querySelector('.vz-panel').getBoundingClientRect(),outer=document.querySelector('.vz-root > .modal-panel').getBoundingClientRect(),title=document.querySelector('.vz-title').getBoundingClientRect(),close=document.querySelector('.vz-close').getBoundingClientRect();return{panel:panel.toJSON(),outer:outer.toJSON(),contained:panel.left>=outer.left&&panel.right<=outer.right&&panel.top>=outer.top&&panel.bottom<=outer.bottom,viewport:outer.left>=0&&outer.right<=innerWidth&&outer.top>=0&&outer.bottom<=innerHeight,titleCentered:Math.abs((title.left+title.right-outer.left-outer.right)/2)<1,closeInside:close.left>=panel.left&&close.right<=panel.right&&close.top>=panel.top&&close.bottom<=panel.bottom}})()`);
    assert(shell.contained&&shell.viewport&&shell.titleCentered&&shell.closeInside,JSON.stringify(shell));
    assert(geometry.withinDialog&&geometry.sameRow&&geometry.otherRowsFit&&geometry.intrinsicBodyRows&&geometry.ownedBody&&geometry.oneMessage&&geometry.messageAbove,JSON.stringify({geometry,rows}));
    assert(!geometry.hasMessage||geometry.messageHeight>0,JSON.stringify(geometry));
    assert(geometry.messageHeight<=geometry.sidebarHeight*.4+1,JSON.stringify(geometry));
    assert(await cdp.evaluate("(()=>{const body=document.querySelector('.vz-sidebar-body'),saved=body.scrollTop,box=body.getBoundingClientRect();body.scrollTop=0;const first=body.firstElementChild.getBoundingClientRect().top>=box.top-1;body.scrollTop=body.scrollHeight;const last=body.lastElementChild.getBoundingClientRect().bottom<=box.bottom+1;body.scrollTop=saved;return first&&last})()"));
    if(expectOverflow){
      assert(geometry.messageScroll>geometry.messageHeight&&geometry.messageOverflow==='auto',JSON.stringify(geometry));
      assert(await cdp.evaluate("(()=>{const messages=document.querySelector('.vz-messages');messages.scrollTop=messages.scrollHeight;const scrolled=messages.scrollTop>0;messages.scrollTop=0;return scrolled})()"));
    }
  };
  const graph = {
    '470': {class_type:'LoadImage',inputs:{image:'canny.png'}},
    '475': {class_type:'LoadImage',inputs:{image:'canny.png'}},
    '9': {class_type:'BasicScheduler',inputs:{denoise:1,steps:20,scheduler:'simple'}},
    '2': {class_type:'CLIPTextEncode',inputs:{text:'original prompt'}},
    '461': {class_type:'SaveImage',inputs:{filename_prefix:'recipe',images:['470',0]}},
  };
  let alias=false;
  await http(FAKE,'/__test/activity','POST',{captureEnqueue:true,publish:[{name:'recipe_00001_.png',fixture:'flux-basic.png',graph,mtime:2100000100},{name:'recipe-b.png',fixture:'flux-basic.png',graph,mtime:2100000099}]});
  await cdp.evaluate("(async()=>{await fetch('/api/collections/fake/entries/recipe_00001_.png/bytes')})()");
  await cdp.evaluate(`(()=>{window.__recipeCreate=URL.createObjectURL;window.__recipeRevoke=URL.revokeObjectURL;window.__recipeURLs=[];window.__recipeRevoked=[];
    URL.createObjectURL=file=>{const url=window.__recipeCreate(file);window.__recipeURLs.push({url,file});return url};URL.revokeObjectURL=url=>{window.__recipeRevoked.push(url);window.__recipeRevoke(url)}})()`);
  try {
    await open();await fixedSummary(); await type('.vz-suffix','_naming-suffix'); const namingStart=(await jobs()).length;
    assert.equal((await invoke('variations.run')).adopted,true);
    const namingJobs=(await jobs()).slice(namingStart);assert.equal(namingJobs.length,3);
    assert(namingJobs.every(job=>job.prompt['461'].inputs.filename_prefix==='recipe_00001__naming-suffix'));
    await cdp.poll("!document.querySelector('.vz-panel')",6000);await open();
    assert.equal(await cdp.evaluate("document.querySelector('.vz-suffix').value"),'_naming-suffix'); await close();
    check('recipe scenario 1: naming suffix reaches every actual prompt, automatically closes and recovers on reopen',true);

    await cdp.evaluate("(async()=>{await fetch('/api/collections/fake/entries/recipe-b.png/bytes')})()");await invoke('variations.open',{id:'fake:recipe-b.png'});await cdp.poll("document.querySelectorAll('.vz-slider-row').length>0");await close();
    await open();assert.equal(await cdp.evaluate("document.querySelector('.vz-suffix').value"),'_naming-suffix');
    await cdp.poll("document.querySelectorAll('.vz-image-set').length===2");
    await cdp.clickAt('[data-param-key="9.steps"] .checkbox');
    await cdp.clickAt('[data-param-key="9.steps"] .noUi-handle[data-handle="0"]');await cdp.keyTrusted('ArrowRight',{vk:39});
    await cdp.evaluate("window.__recipeRange=document.querySelector('[data-param-key=\"9.steps\"] .noUi-handle[data-handle=\"0\"]').getAttribute('aria-valuenow')");
    await type('[data-param-key="9.steps"] .vz-row-inc-input','1e');await cdp.clickAt('[data-param-key="9.steps"] .checkbox');
    await cdp.clickAt('[data-enum-id="9.scheduler"] .vz-imgrow-head .checkbox');await cdp.clickAt('[data-enum-id="9.scheduler"] .vz-enum-opt:last-child .checkbox');await cdp.clickAt('[data-enum-id="9.scheduler"] .vz-imgrow-head .checkbox');
    await cdp.clickAt('[data-text-id="2.text"] .checkbox');await type('.vz-text-values','{{parked}}');await type('.vz-tpl-input','one; two');await type('.vz-text-values','literal submitted');
    await cdp.evaluate(`(async()=>{const bytes=await(await fetch('/api/collections/fake/entries/flux-lora.png/bytes')).arrayBuffer();
      window.__recipeFiles=['#%.png','question?.png','spaces Ω [input].png'].map(name=>new File([bytes],name,{type:'image/png'}));
      window.__recipeDormant=new File([bytes],'dormant.png',{type:'image/png'});
      for(const [id,files] of [['470.image',window.__recipeFiles],['475.image',[window.__recipeDormant]]]){const input=document.querySelector('[data-image-id="'+id+'"] .vz-imgfilespick'),dt=new DataTransfer();files.forEach(file=>dt.items.add(file));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}))}})()`);
    await cdp.clickAt('[data-image-id="470.image"] .checkbox');await cdp.clickAt('[data-param-key="9.denoise"] .checkbox');
    await type('.vz-suffix','_{470.image}');await cdp.poll("!document.querySelector('.vz-image-check')");
    await capture('recipe-captured');const before=(await jobs()).length;
    assert.equal((await invoke('variations.run')).adopted,true);
    const submitted=(await jobs()).slice(before);assert.equal(submitted.length,3);
    assert.deepEqual(submitted.map(job=>job.prompt['470'].inputs.image),['#%.png','question?.png','spaces Ω [input].png']);
    assert(submitted.every(job=>job.prompt['9'].inputs.steps===20&&job.prompt['475'].inputs.image==='canny.png'&&job.prompt['2'].inputs.text==='literal submitted'));
    assert.deepEqual(submitted.map(job=>job.prompt['461'].inputs.filename_prefix),submitted.map(job=>'recipe_00001__'+job.prompt['470'].inputs.image));
    await cdp.poll("!document.querySelector('.vz-panel')",6000);
    assert(await cdp.evaluate("window.__recipeURLs.every(item=>window.__recipeRevoked.includes(item.url))"));
    const urlStart=await cdp.evaluate('window.__recipeURLs.length');await open();await cdp.poll("document.querySelectorAll('.vz-image-tile').length===4&&!document.querySelector('.vz-image-check')");
    assert(await cdp.evaluate(`window.__recipeFiles.concat(window.__recipeDormant).every(file=>window.__recipeURLs.slice(${urlStart}).some(item=>item.file===file))`));
    assert.equal(await cdp.evaluate("document.querySelector('[data-param-key=\"9.steps\"] .vz-row-inc-input').value"),'1e');
    assert.equal(await cdp.evaluate("document.querySelector('[data-param-key=\"9.steps\"] .checkbox').checked"),false);
    assert(await cdp.evaluate("document.querySelector('[data-param-key=\"9.steps\"] .noUi-handle[data-handle=\"0\"]').getAttribute('aria-valuenow')===window.__recipeRange"));
    await capture('recipe-recovered');await type('.vz-text-values','{{parked}}');assert.equal(await cdp.evaluate("document.querySelector('.vz-tpl-input').value"),'one; two');
    await type('.vz-text-values','literal submitted');
    await cdp.clickAt('[data-enum-id="9.scheduler"] .vz-imgrow-head .checkbox');assert.equal(await cdp.evaluate("document.querySelector('[data-enum-id=\"9.scheduler\"] .vz-enum-opt:last-child .checkbox').checked"),true);await cdp.clickAt('[data-enum-id="9.scheduler"] .vz-imgrow-head .checkbox');
    await cdp.poll("document.querySelector('[data-enum-id=\"9.scheduler\"] .vz-imgrow-head .checkbox').checked===false");
    check('recipe scenarios 2–3: disabled raw controls, enum picks, dormant templates and identical native Files recover after 3 exact hostile-name graphs and automatic close; object URLs retire',true);

    // Enabled-empty and unresolved naming reject without a single fake enqueue.
    await cdp.clickAt('[data-image-id="475.image"] .checkbox');await cdp.poll("document.querySelector('[data-image-id=\"475.image\"] .checkbox').checked===true");await cdp.clickAt('[data-image-id="475.image"] .vz-image-tile .chrome-icon');
    await cdp.poll("document.querySelectorAll('[data-image-id=\"475.image\"] .vz-image-tile').length===0");
    let count=(await jobs()).length;assert.equal((await invoke('variations.run')).adopted,false);assert.equal((await jobs()).length,count);
    assert(await cdp.evaluate("document.querySelector('.vz-error').textContent.includes('at least one image')"));
    await cdp.clickAt('[data-image-id="475.image"] .checkbox');await cdp.poll("document.querySelector('[data-image-id=\"475.image\"] .checkbox').checked===false");
    // The fake intentionally returns 409 for repeated names (unlike stock byte
    // dedupe). These independent preflight cases must not retry accepted Files.
    await cdp.clickAt('[data-image-id="470.image"] .checkbox');await cdp.poll("document.querySelector('[data-image-id=\"470.image\"] .checkbox').checked===false");await type('.vz-suffix','_{unknown}');
    count=(await jobs()).length;await invoke('variations.run');assert.equal((await jobs()).length,count);
    assert(await cdp.evaluate("document.querySelector('.vz-error').textContent.includes('naming token')"),await cdp.evaluate("document.querySelector('.vz-error').textContent"));
    await fixedSummary();await capture('recipe-preflight');
    await cdp.evaluate(`(()=>{const original=window.fetch;window.__recipeLongRestore=()=>window.fetch=original;window.fetch=(url,options)=>String(url).includes('/features/variations/run')?Promise.resolve(new Response(JSON.stringify({error:'Long preflight reason: '+('This operation cannot be applied. '.repeat(200))}),{status:400})):original(url,options)})()`);
    try{count=(await jobs()).length;await invoke('variations.run');assert.equal((await jobs()).length,count);await fixedSummary(true);await capture('recipe-long-error');}
    finally{await cdp.evaluate('window.__recipeLongRestore()')}
    check('recipe layout: normal, preflight and long-error states keep intrinsic content reachable through the sidebar body, bounded messages directly above pinned Run',true);
    await type('.vz-suffix','_{470.image}');
    for(let remaining=3;remaining>0;remaining--){await cdp.clickAt('[data-image-id="470.image"] .vz-image-tile .chrome-icon');await cdp.poll(`document.querySelectorAll('[data-image-id="470.image"] .vz-image-tile').length===${remaining-1}`)}
    await cdp.evaluate(`(async()=>{const bytes=await(await fetch('/api/collections/fake/entries/flux-lora.png/bytes')).arrayBuffer(),input=document.querySelector('[data-image-id="470.image"] .vz-imgfilespick'),dt=new DataTransfer();dt.items.add(new File([bytes],'x'.repeat(196)+'.png',{type:'image/png'}));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await cdp.clickAt('[data-image-id="470.image"] .checkbox');await cdp.poll("document.querySelector('[data-image-id=\"470.image\"] .checkbox').checked===true&&!document.querySelector('.vz-image-check')");count=(await jobs()).length;await invoke('variations.run');assert.equal((await jobs()).length,count);
    assert(await cdp.evaluate("document.querySelector('.vz-error').textContent.includes('naming would be folded')"));
    await cdp.clickAt('.vz-close');await cdp.poll("!!document.querySelector('.vz-discard')");await cdp.clickAt('.vz-discard-confirm');await cdp.poll("!document.querySelector('.vz-panel')");
    check('recipe preflight: enabled-empty, unknown naming and a 200-character filename reject clearly with zero jobs',true);

    const missing=structuredClone(graph);delete missing['9'].inputs.steps;
    await http(FAKE,'/__test/activity','POST',{publish:[{name:'recipe-batch-full.png',fixture:'flux-basic.png',graph},{name:'recipe-batch-missing.png',fixture:'flux-basic.png',graph:missing}]});
    await cdp.evaluate("(async()=>{for(const name of ['recipe-batch-full.png','recipe-batch-missing.png'])await fetch('/api/collections/fake/entries/'+name+'/bytes')})()");
    await invoke('variations.open',{ids:['fake:recipe-batch-full.png','fake:recipe-batch-missing.png'],bulk:true});await cdp.poll("document.querySelectorAll('.vz-slider-row').length>0");
    await cdp.clickAt('[data-param-key="9.steps"] .checkbox');await type('.vz-suffix','');
    count=(await jobs()).length;const batch=await invoke('variations.run');assert.equal(batch.adopted,true);
    const batchJobs=(await jobs()).slice(count);assert.equal(batchJobs.length,batch.submitted);
    const fullJobs=batchJobs.filter(job=>job.extra_data.extra_pnginfo.kz.source==='fake:recipe-batch-full.png'),missingJobs=batchJobs.filter(job=>job.extra_data.extra_pnginfo.kz.source==='fake:recipe-batch-missing.png');
    assert(fullJobs.length>0&&missingJobs.length>0);assert(fullJobs.every(job=>Object.hasOwn(job.extra_data.extra_pnginfo.kz.params,'9.steps')));assert(missingJobs.every(job=>!Object.hasOwn(job.prompt['9'].inputs,'steps')&&!Object.hasOwn(job.extra_data.extra_pnginfo.kz.params,'9.steps')));
    await cdp.poll("!document.querySelector('.vz-panel')",6000);
    check('recipe applicability: heterogeneous batch proves each applicable operation, explicitly excludes absent relative numeric work and checkpoints only after both targets accept',true);

    const address=new URL(FAKE).host;await http(ENGINE,'/api/collections','POST',{name:'recipe-owner',address});alias=true;
    await cdp.poll(`(async()=>!!${KZ}.state.hosts['recipe-owner'])()`);await cdp.evaluate("(async()=>{await fetch('/api/collections/recipe-owner/entries/recipe_00001_.png/bytes')})()");
    await open('recipe-owner');await cdp.poll("document.querySelectorAll('.vz-image-set').length===2");
    await cdp.evaluate("(()=>{const input=document.querySelector('[data-image-id=\"475.image\"] .vz-imgfilespick'),dt=new DataTransfer();dt.items.add(window.__recipeDormant);input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()");
    assert.equal((await invoke('variations.run')).adopted,true);await cdp.poll("!document.querySelector('.vz-panel')",6000);
    const oldIncarnation=await cdp.evaluate(`(async()=>${KZ}.state.hosts['recipe-owner'].sourceVersion.incarnation)()`);
    await http(ENGINE,'/api/collections/recipe-owner','DELETE');alias=false;await http(ENGINE,'/api/collections','POST',{name:'recipe-owner',address});alias=true;
    await cdp.poll(`(async()=>${KZ}.state.hosts['recipe-owner']?.sourceVersion.incarnation!==${JSON.stringify(oldIncarnation)}&&!!${KZ}.state.hosts['recipe-owner'])()`);await cdp.evaluate("(async()=>{await fetch('/api/collections/recipe-owner/entries/recipe_00001_.png/bytes')})()");
    await open('recipe-owner');await cdp.poll("!!document.querySelector('.vz-workspace-status')");
    await fixedSummary();
    assert(await cdp.evaluate("document.querySelector('.vz-run').disabled&&!document.querySelector('.vz-left input')&&document.querySelector('.vz-retained-values').textContent.includes('dormant.png')"));
    count=(await jobs()).length;assert.equal((await invoke('variations.run')).status,'stale');assert.equal((await jobs()).length,count);
    await fixedSummary();
    await capture('recipe-old-origin');await cdp.clickAt('.vz-workspace-new');await cdp.poll("!document.querySelector('.vz-workspace-status')&&document.querySelectorAll('.vz-workspace option').length===2");
    const currentWorkspace=await cdp.evaluate("document.querySelector('.vz-workspace').value");await type('.vz-prefix','kept-current');
    await cdp.evaluate("(()=>{const select=document.querySelector('.vz-workspace');select.value=[...select.options].find(option=>option.textContent.includes('Previous')).value;select.dispatchEvent(new Event('change',{bubbles:true}))})()");
    await cdp.poll("!!document.querySelector('.vz-discard')");await cdp.clickAt('.vz-keep');
    assert.equal(await cdp.evaluate("document.querySelector('.vz-workspace').value"),currentWorkspace);assert.equal(await cdp.evaluate("document.querySelector('.vz-prefix').value"),'kept-current');
    await cdp.clickAt('.vz-workspace-discard');await cdp.clickAt('.vz-discard-confirm');await cdp.poll("!document.querySelector('.vz-discard')&&document.querySelector('.vz-prefix')?.value===''");
    await cdp.evaluate("(()=>{const select=document.querySelector('.vz-workspace');select.value=[...select.options].find(option=>option.textContent.includes('Previous')).value;select.dispatchEvent(new Event('change',{bubbles:true}))})()");
    await cdp.poll("!!document.querySelector('.vz-workspace-status')");await cdp.clickAt('.vz-workspace-discard');await cdp.poll("!!document.querySelector('.vz-discard')");await cdp.clickAt('.vz-keep');assert.equal(await cdp.evaluate("document.querySelectorAll('.vz-workspace option').length"),2);
    await cdp.clickAt('.vz-workspace-discard');await cdp.clickAt('.vz-discard-confirm');await cdp.poll("!document.querySelector('.vz-workspace-status')&&document.querySelectorAll('.vz-workspace option').length===1");await close();
    check('recipe origin recovery: previous source is visibly inspectable without retarget or effects; explicit new workspace, Keep editing and committed removal preserve independent identities',true);
  } finally {
    await cdp.evaluate("URL.createObjectURL=window.__recipeCreate;URL.revokeObjectURL=window.__recipeRevoke");
    if(await cdp.evaluate("!!document.querySelector('.vz-panel')")){await cdp.evaluate(`(async()=>{${KZ}.handles.invoke('variations.close');return true})()`);if(await cdp.evaluate("!!document.querySelector('.vz-discard')"))await cdp.clickAt('.vz-discard-confirm');}
    if(alias)await http(ENGINE,'/api/collections/recipe-owner','DELETE');await http(FAKE,'/__test/activity','POST',{captureEnqueue:false});
  }
};
