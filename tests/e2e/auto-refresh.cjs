// Real upstream -> Jobs -> cached API -> Store -> decoded card, no rescue input.
const assert = require('node:assert/strict');
module.exports = async ({ page, ENGINE, FAKE, KZ, check, traffic }) => {
  const control = async body => {
    const response = await fetch(FAKE + '/__test/activity', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    assert.equal(response.status,200); await response.json();
  };
  const waitLogs = async () => {
    for(let i=0;i<100;i++) {
      if((await (await fetch(FAKE+'/__test/telemetry')).json()).activeLogs>0)return;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    throw Error('controlled auxiliary log request did not start');
  };
  const retained='.card[data-name="auto-flow/retained.png"]';
  const sourceOutage=`(async()=>{const s=${KZ};return {
    host:s.state.host(),online:s.state.hosts.fake?.online,
    offline:!!document.querySelector('.hostpick.off[data-source="fake"]')&&!!document.querySelector('#hostBtn .hdot.off'),
    errors:[...document.querySelectorAll('#statusStack .error')].map(e=>e.textContent)
      .filter(text=>text.includes('GET /api/collections/fake/entries?inventory=1: 502 — collection unreachable:')),
  };})()`;
  const failedInventoryReads=()=>{
    const ids=new Set(traffic.requests.filter(request=>{
      const url=new URL(request.url);
      return url.origin===ENGINE&&url.pathname==='/api/collections/fake/entries'&&url.searchParams.get('inventory')==='1';
    }).map(request=>request.id));
    return traffic.responses.filter(response=>response.status===502&&ids.has(response.id)).length;
  };
  const snapshot=()=>page.evaluate(`(async()=>{
    const s=${KZ}, panel=document.querySelector('.vz-panel'), card=document.querySelector(${JSON.stringify(retained)});
    return {current:s.state.current(),trail:s.state.currentStack(),url:location.href,folder:s.state.selectedFolder(),
      memory:localStorage.getItem('kosmozoo.sourceBrowse.v1'),selected:JSON.parse(JSON.stringify(s.state.selected)),
      note:card?.querySelector('textarea.pos')?.value,session:panel?.dataset.session,
      fields:panel?[...panel.querySelectorAll('input:not([type=file]),textarea,select')].map(e=>[e.value,e.checked]):[],
      sameCard:card===window.__autoFlowCard,sameEditor:card?.querySelector('textarea.pos')===window.__autoFlowEditor,
      samePanel:panel===window.__autoFlowPanel};
  })()`);
  let initialScript;
  try {
    await page.evaluate(`(async()=>{const s=${KZ}; await s.actions.hosts.patch('fake',{autoRefresh:false,pinned:true});
      s.actions.ui.setFilter('');s.actions.bulk.clear();s.actions.diff.hide();})()`);
    await control({reset:true,publish:[{name:'auto-flow/retained.png',width:128,height:72,mtime:2200000000}],
      running:['auto-flow-A'],pending:['auto-flow-B'],delays:{logs:8000}});
    await page.evaluate(`(async()=>{const s=${KZ};await s.actions.hosts.select('fake');await s.actions.ui.refresh();
      s.actions.folders.select('auto-flow');})()`);
    await page.poll(`document.querySelector(${JSON.stringify(retained)}+' img')?.naturalWidth===128`,20000);
    await page.poll(`(async()=>${KZ}.state.sourceActivity.fake?.runningPromptId==='auto-flow-A')()`,15000);
    await page.evaluate(`(async()=>{const s=${KZ},{api}=await import('/js/api.mjs');
      await s.actions.hosts.patch('fake',{autoRefresh:true});
      let release;const gate=new Promise(resolve=>release=resolve);
      window.__autoFlowOriginalWriter=api.setJudgment;window.__autoFlowRelease=release;
      api.setJudgment=async(...args)=>{await gate;return window.__autoFlowOriginalWriter(...args)};
      s.actions.selected.set('fake:auto-flow/retained.png',true);
      window.__autoFlowCard=document.querySelector(${JSON.stringify(retained)});
      window.__autoFlowEditor=window.__autoFlowCard.querySelector('textarea.pos');window.__autoFlowEditor.focus();
    })()`);
    await page.send('Input.insertText',{text:'completion-flow retained note'});
    await page.evaluate(`(async()=>await ${KZ}.handles.invoke('variations.open',{id:'fake:flux-basic.png'}))()`);
    const field='.vz-slider-row[data-param-key$="denoise"] .vz-row-inc-input';
    await page.poll(`!!document.querySelector(${JSON.stringify(field)})`,20000);
    await page.evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(field)});input.focus();input.select();})()`);
    await page.send('Input.insertText',{text:'1e'});
    await page.evaluate(`window.__autoFlowPanel=document.querySelector('.vz-panel')`);
    const before=await snapshot();
    assert.equal(before.note,'completion-flow retained note');
    const revision=await page.evaluate(`(async()=>${KZ}.state.sourceActivity.fake.terminalRevision)()`);
    await waitLogs();
    const first=Date.now();
    await control({running:['auto-flow-B'],pending:['auto-flow-C'],finish:[{id:'auto-flow-A',output:'auto-flow/first.png',width:73,height:31,mtime:2199999999}]});
    await page.poll(`(async()=>{const source=${KZ}.state.sourceActivity.fake;return source?.terminalRevision>${revision}&&source.runningPromptId==='auto-flow-B';})()`,7000);
    await page.poll(`document.querySelector('.card[data-name="auto-flow/first.png"] img')?.naturalWidth===73`,7000);
    const firstMs=Date.now()-first;
    if(traffic)assert(traffic.frames.some(event=>{
      const frame=JSON.parse(event.data),activity=frame.sources.fake?.activity;
      return activity?.terminalRevision>revision&&activity.runningPromptId==='auto-flow-B';
    }),'completion reaches the real native event stream before decoded output');
    assert.deepEqual(await snapshot(),before);
    const source=await page.evaluate(`(async()=>({state:${KZ}.state.sourceActivity.fake.state,prompt:${KZ}.state.sourceActivity.fake.runningPromptId,
      terminal:${KZ}.state.sourceActivity.fake.terminalRevision}))()`);
    assert.equal(source.state,'running');assert.equal(source.prompt,'auto-flow-B');assert(source.terminal>revision);
    check('completion flow: decoded output while next job runs and optional progress is held, with exact editor/browse retention',true,JSON.stringify({firstMs,source}));

    const connections=traffic?.streams().length;
    await page.evaluate(`window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}))`);
    await page.poll(`(async()=>${KZ}.state.sourceDelivery()==='suspended')()`);
    assert(await page.evaluate(`(()=>{const svg=document.querySelector('.pinned-source[data-source="fake"] .source-progress');
      return svg?.dataset.state==='disconnected'&&!svg.querySelector('.source-progress-fill')&&svg.getAttribute('aria-label').includes('cached upstream running');})()`),
      'delivery disconnection withholds cached running fill and labels the independent upstream state');
    assert.deepEqual(await snapshot(),before);
    await control({publish:[{name:'auto-flow/gap.png',width:83,height:37,mtime:2199999997}]});
    await page.evaluate(`window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))`);
    await page.poll(`(async()=>${KZ}.state.sourceDelivery()==='ready')()`);
    await page.poll(`document.querySelector('.card[data-name="auto-flow/gap.png"] img')?.naturalWidth===83`,15000);
    assert.deepEqual(await snapshot(),before);
    assert.equal(await page.evaluate(`(async()=>${KZ}.state.sourceActivity.fake.terminalRevision)()`),source.terminal,
      'gap freshness repair cannot fabricate a terminal event');
    if(traffic)assert.equal(traffic.streams().length,connections+1);
    check('completion flow: real output published during lifecycle delivery gap decodes after recovery with unchanged Jobs tuple and retained editing',true);

    await page.poll(`(async()=>{const state=await ${sourceOutage};return state.host==='fake'&&state.online===true&&state.errors.length===0;})()`,15000);
    const failedBefore=traffic?failedInventoryReads():0;
    await control({failures:{listing:503},running:['auto-flow-C'],pending:[],finish:[{id:'auto-flow-B',output:'auto-flow/retry.png',width:79,height:35,mtime:2199999998}]});
    // The first failed wave can reach either root or descendant inventory.
    // Later retries remain the same outage and must not manufacture another chip.
    await page.poll(`(async()=>{const state=await ${sourceOutage};return state.errors.some(text=>/collection unreachable: ComfyUI (?:listing|inventory): 503$/.test(text));})()`,15000);
    if(traffic){
      const deadline=Date.now()+15000;
      while(failedInventoryReads()-failedBefore<4&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
      assert(failedInventoryReads()-failedBefore>=4,'initial failure plus at least three automatic inventory retries');
    }
    const outage=await page.evaluate(sourceOutage);
    assert.equal(outage.host,'fake');assert.equal(outage.online,false);assert(outage.offline);
    assert.equal(outage.errors.length,1,'exactly one error for this source throughout the outage');
    assert.deepEqual(await snapshot(),before);
    check('completion flow: injected source 503 stays one offline error across automatic retries',true,
      JSON.stringify({...outage,failedReads:traffic?failedInventoryReads()-failedBefore:null}));
    await control({failures:{}});
    await page.poll(`document.querySelector('.card[data-name="auto-flow/retry.png"] img')?.naturalWidth===79`,15000);
    await page.poll(`(async()=>{const state=await ${sourceOutage};return state.host==='fake'&&state.online===true&&!state.offline&&state.errors.length===0;})()`,15000);
    assert.deepEqual(await snapshot(),before);
    check('completion flow: successful inventory recovery clears the source error and offline presentation',true);
    check('completion flow: failed inventory preserves work and autonomously retries the same target to decoded bytes',true);

    await page.evaluate(`(async()=>{const s=${KZ},{api}=await import('/js/api.mjs');window.__autoFlowRelease();
      api.setJudgment=window.__autoFlowOriginalWriter;window.__autoFlowOriginalWriter=null;
      window.__autoFlowLeave=s.handles.invoke('variations.close');})()`);
    await page.poll(`!!document.querySelector('.vz-discard')`);
    await page.clickAt('.vz-discard-confirm');await page.poll(`!document.querySelector('.vz-panel')`);
    await control({delays:{},finish:[{id:'auto-flow-C',outcome:'interrupted'}]});
    const script=await page.send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{
      const original=window.fetch;let rejected=false;window.__autoFlowInitialReads=0;
      window.fetch=(url,options)=>{if(String(url).includes('/api/collections/fake/entries?inventory=1')){
        window.__autoFlowInitialReads++;if(!rejected){rejected=true;return Promise.resolve(new Response(JSON.stringify({error:'controlled initial inventory failure'}),{status:502,headers:{'Content-Type':'application/json'}}));}
      }return original(url,options);};
    })()`});
    initialScript=script.identifier;
    await page.goto(ENGINE+'/#fake#bulk-02500.png');
    try {
      await page.poll(`document.querySelector('.card[data-name="bulk-02500.png"] img')?.naturalWidth===640`,20000);
    } catch(error) {
      console.log('COLD RESTORE CONSUMER',JSON.stringify(await page.evaluate(`(async()=>{const s=${KZ};return{
        reads:window.__autoFlowInitialReads,current:s.state.current(),count:s.state.images.length,
        scrollTop:s.state.feedScrollEl()?.scrollTop,rendered:[...document.querySelectorAll('.card')].map(e=>e.dataset.name),
        inventory:s.state.inventory,range:s.state.feedVirtualizer()?.getVirtualItems().map(e=>({index:e.index,key:e.key})),
      }})()`)));
      throw error;
    }
    const restored=await page.evaluate(`(async()=>({reads:window.__autoFlowInitialReads,current:${KZ}.state.current(),
      src:document.querySelector('.card[data-name="bulk-02500.png"] img').currentSrc,
      top:${KZ}.state.feedScrollEl().scrollTop}))()`);
    assert(restored.reads>=2);assert.equal(restored.current.image,'bulk-02500.png');assert(restored.top>10000);
    check('completion flow: cold deep restore recovers a failed initial read to decoded pixels without scroll/current rescue',true,JSON.stringify(restored));
    if(traffic){traffic.save('source-traffic-final');await traffic.validate();assert.equal(traffic.activity().length,0);}
  } catch(error) { check('completion-to-decoded-output regression',false,error.stack??String(error));throw error; }
  finally {
    if(initialScript)await page.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:initialScript});
    await page.evaluate(`(async()=>{const s=${KZ},{api}=await import('/js/api.mjs');window.__autoFlowRelease?.();
      if(window.__autoFlowOriginalWriter)api.setJudgment=window.__autoFlowOriginalWriter;
      await s.actions.hosts.patch('fake',{autoRefresh:false,pinned:false});s.actions.ui.setFilter('');s.actions.folders.select('');s.actions.bulk.clear();})()`);
    await control({reset:true});
  }
};
