// Actual consumer outcomes. No substituted visibility or product CSS/state policy.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {CDP,collectPageErrors}=require('./cdp.cjs');
const ENGINE=process.env.E2E_ENGINE??'http://127.0.0.1:20480',FAKE=process.env.E2E_FAKE??'http://127.0.0.1:20482';
const KZ='(await import("/store/instance.js")).appStore';
async function run(page){
  const run=require('node:crypto').randomUUID(),root=process.env.E2E_EVIDENCE,shots=process.env.E2E_SHOTS??path.join(root,'shots');
  fs.mkdirSync(shots,{recursive:true});const records=[],created=[];
  const control=async body=>{const r=await fetch(FAKE+'/__test/activity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200);await r.json();};
  const invoke=(id,args={})=>page.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const fresh=label=>`matrix/${run}/${label}`;
  const has=name=>`(async()=>${KZ}.state.entryHasNew(${JSON.stringify('another:'+name)}))()`;
  const seen=name=>`(async()=>!await ${has(name)})()`;
  const attention=`(async()=>${KZ}.state.sourceHasNew('another'))()`;
  const frame=()=>page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const refresh=()=>page.evaluate(`(async()=>${KZ}.actions.ui.refresh())()`);
  const select=()=>page.evaluate(`(async()=>{const s=${KZ};await s.actions.hosts.select('another');s.actions.ui.setFilter('');s.actions.folders.select('');})()`);
  const anchor=async()=>{
    // A CDP viewport change returns before Grid's ResizeObserver has updated
    // the virtualizer. Let native layout settle before the ONE restore.
    await frame();
    await page.evaluate(`(async()=>{const s=${KZ};s.actions.diff.hide();s.actions.ui.setFilter('');s.actions.folders.select('');
      const i=s.state.images.findIndex(e=>e.filename==='bulk-00035.png');s.actions.current.set('another','bulk-00035.png');s.actions.feed.restoreToIndex(i);})()`);
    await page.poll(`document.querySelector('.card[data-name="bulk-00035.png"] img')?.naturalWidth>0`,20000);await frame();
  };
  const publish=async(label,options={})=>{
    const name=fresh(label);created.push(name);
    await control({publish:[{name,fixture:'flux-basic.png',width:150,height:90,mtime:1,...options}]});await refresh();
    await page.poll(`(async()=>${KZ}.state.images.some(e=>e.filename===${JSON.stringify(name)}))()`,20000);
    return name;
  };
  const remove=async names=>{await control({remove:names});await refresh();};
  const reveal=async(name,{loaded=true}={})=>{
    const navigation=await page.evaluate(`(async()=>{const s=${KZ},i=s.state.images.findIndex(e=>e.filename===${JSON.stringify(name)});if(i<0)throw Error('missing matrix entry');
      if(s.state.entriesWithKnownSize().includes(i)){s.actions.feed.restoreToIndex(i);return {pending:false};}
      return {pending:true,result:await s.handles.invoke('entry.navigate',{source:'another',file:${JSON.stringify(name)}})};})()`);
    if(navigation.pending)assert.equal(navigation.result,true,'normal pending-size navigation accepted');
    await page.poll(`(async()=>{const s=${KZ};return s.state.entriesWithKnownSize().some(i=>s.state.images[i].filename===${JSON.stringify(name)});})()`,loaded?20000:90000);
    await page.poll(`!!document.querySelector('.card[data-name="${name}"]')`,20000);
    if(loaded)await page.poll(`(()=>{const b=document.querySelector('.card[data-name="${name}"] .media-box');return b?.classList.contains('ic-loaded');})()`,20000);
    await frame();
  };
  const shot=async name=>{const image=await page.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(shots,name+'.png'),Buffer.from(image.data,'base64'));};
  const record=async(name,detail={})=>{
    const value=await page.evaluate(`(async()=>{const s=${KZ},link=document.querySelector('link[rel="icon"]');return {visibility:document.visibilityState,source:s.state.sourceHasNew('another'),any:s.state.anySourceHasNew(),
      favicon:{href:link.getAttribute('href'),type:link.getAttribute('type'),sizes:link.getAttribute('sizes')},scroll:document.querySelector('#candidatesCol').scrollTop};})()`);
    records.push({name,...detail,...value});fs.writeFileSync(path.join(root,'matrix.json'),JSON.stringify({run,records},null,2));console.log('ok '+name);
  };
  const quiet=async()=>{await page.poll(`(async()=>!await ${attention})()`,20000);};
  const sourcePresentation=async({selected,pinned,online=true})=>{
    const actual=await page.evaluate(`(async()=>{const s=${KZ},row=document.querySelector('.hostpick[data-source="another"]'),chip=document.querySelector('.pinned-source[data-source="another"]');
      return {fact:s.state.sourceHasNew('another'),rowNew:row?.classList.contains('has-new'),rowCurrent:row?.classList.contains('current'),rowOffline:row?.classList.contains('off'),
        rowTitle:row?.title,rowAria:row?.getAttribute('aria-label'),chip:!!chip,chipNew:chip?.classList.contains('has-new'),chipOn:chip?.classList.contains('on')};})()`);
    assert(actual.fact);assert(actual.rowNew);assert.equal(actual.rowCurrent,selected);assert.equal(actual.rowOffline,!online);assert.equal(actual.rowTitle,actual.rowAria);assert(actual.rowTitle.includes('New images.'));
    assert.equal(actual.chip,pinned);if(pinned){assert(actual.chipNew);assert.equal(actual.chipOn,selected);}return actual;
  };
  await page.send('Emulation.setDeviceMetricsOverride',{width:1400,height:900,deviceScaleFactor:1,mobile:false});
  await page.goto(ENGINE+'/#another');await page.poll(`(async()=>${KZ}.state.sourceDelivery()==='ready'&&!${KZ}.state.inventory.loading)()`,20000);
  await page.evaluate(`(async()=>${KZ}.actions.hosts.patch('another',{pinned:true,autoRefresh:true}))()`);await select();await anchor();
  const original=await page.evaluate(`(()=>{const l=document.querySelector('link[rel="icon"]');return {href:l.getAttribute('href'),type:l.getAttribute('type'),sizes:l.getAttribute('sizes')};})()`);
  try{
    if(!['sticky','failed','single'].includes(process.env.E2E_MATRIX_FROM)){
    // Navigation, current assignment, filter remount and unpinned membership.
    const browsing=()=>page.evaluate(`(async()=>{const s=${KZ};return {current:s.state.current(),trail:s.state.currentStack(),url:location.href,top:document.querySelector('.card[data-name="bulk-00035.png"]').getBoundingClientRect().top};})()`);
    const beforeBrowsing=await browsing(),above=await publish('above.png',{mtime:4102445000});
    const retained=await publish('retained.png');await page.poll(has(retained));await page.poll(has(above));
    await page.poll(`(async()=>{const s=${KZ};return s.state.entriesWithKnownSize().some(i=>s.state.images[i].filename===${JSON.stringify(above)});})()`,20000);await frame();
    const afterBrowsing=await browsing();assert.deepEqual(afterBrowsing.current,beforeBrowsing.current);assert.deepEqual(afterBrowsing.trail,beforeBrowsing.trail);assert.equal(afterBrowsing.url,beforeBrowsing.url);assert(Math.abs(afterBrowsing.top-beforeBrowsing.top)<=1);
    await record('above-below-arrivals-preserve-anchor',{before:beforeBrowsing,after:afterBrowsing});await remove([above]);
    await page.evaluate(`(async()=>${KZ}.actions.folders.select(${JSON.stringify('hidden-'+run)}))()`);await page.poll(`(async()=>${KZ}.state.view().length===0)()`);
    assert(await page.evaluate(has(retained)));assert(await page.evaluate(attention));await record('folder-hidden-item-retains-shared-attention');
    await page.evaluate(`(async()=>${KZ}.actions.folders.select(''))()`);
    await page.evaluate(`(async()=>${KZ}.actions.current.set('another',${JSON.stringify(retained)}))()`);await frame();assert(await page.evaluate(has(retained)));
    await page.evaluate(`(async()=>{const s=${KZ};s.actions.ui.setFilter('bulk-');await s.actions.hosts.select('fixture-dir');await s.actions.hosts.select('another');})()`);
    await page.poll(`(async()=>!${KZ}.state.inventory.loading)()`,20000);assert(await page.evaluate(has(retained)));
    await sourcePresentation({selected:true,pinned:true});
    await page.evaluate(`(async()=>${KZ}.actions.hosts.patch('another',{autoRefresh:false}))()`);await sourcePresentation({selected:true,pinned:true});
    await page.evaluate(`(async()=>${KZ}.actions.hosts.patch('another',{autoRefresh:true}))()`);await sourcePresentation({selected:true,pinned:true});
    await control({failures:{listing:503}});await refresh();await page.poll(`(async()=>${KZ}.state.hosts.another.online===false)()`);await sourcePresentation({selected:true,pinned:true,online:false});
    await control({failures:{}});await refresh();await page.poll(`(async()=>${KZ}.state.hosts.another.online===true)()`);await sourcePresentation({selected:true,pinned:true});
    await page.evaluate(`(async()=>${KZ}.actions.hosts.select('fixture-dir'))()`);await sourcePresentation({selected:false,pinned:true});
    await page.evaluate(`(async()=>${KZ}.actions.hosts.select('another'))()`);await sourcePresentation({selected:true,pinned:true});
    await page.evaluate(`(async()=>${KZ}.actions.hosts.patch('another',{pinned:false}))()`);await invoke('source.menu.open');
    await page.poll(`document.querySelector('.hostpick[data-source="another"]')?.classList.contains('has-new')`);assert(await page.evaluate(`(async()=>${KZ}.state.anySourceHasNew())()`));
    await record('navigation-filter-unpinned-retains',await sourcePresentation({selected:true,pinned:false}));await invoke('source.menu.close');await page.evaluate(`(async()=>${KZ}.actions.hosts.patch('another',{pinned:true}))()`);await sourcePresentation({selected:true,pinned:true});
    await anchor();await reveal(retained);await page.poll(seen(retained));await quiet();await remove([retained]);

    // Exact holes: view the higher arrival before removing the lower one.
    await anchor();const low=await publish('hole-a.png',{mtime:4102445001}),high=await publish('hole-b.png');await reveal(high);await page.poll(seen(high));
    assert(await page.evaluate(has(low)));assert(await page.evaluate(attention));
    const before=await (await fetch(ENGINE+'/api/collections/another/entries?inventory=1&arrivals=items-v1')).json();
    await remove([low]);await quiet();const after=await (await fetch(ENGINE+'/api/collections/another/entries?inventory=1&arrivals=items-v1')).json();
    assert.equal(after.arrivals.sequence,before.arrivals.sequence);assert.equal(after.arrivals.latestVisibleSeq,before.arrivals.latestVisibleSeq);assert(after.arrivals.revision>before.arrivals.revision);
    await record('out-of-order-hole-and-lower-removal',{before:before.arrivals,after:after.arrivals});await remove([high]);

    // A real second tab supplies actual browser visibility; no hidden overrides.
    await anchor();const hidden=await publish('hidden-tab.png');await invoke('keys.panel.toggle');await reveal(hidden);assert(await page.evaluate(has(hidden)));
    const {targetId}=await page.send('Target.createTarget',{url:'about:blank'}),port=new URL(page.wsUrl).port;
    const target=(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.id===targetId);
    const other=new CDP(page.proc,target.webSocketDebuggerUrl);await other.connect();
    try{await other.send('Page.bringToFront');await page.poll(`document.visibilityState==='hidden'`,10000);await invoke('keys.panel.close');assert(await page.evaluate(has(hidden)));await record('native-hidden-tab-retains');}
    finally{await page.send('Page.bringToFront');await page.send('Target.closeTarget',{targetId});other.ws.close();}
    await page.poll(`(async()=>document.visibilityState==='visible'&&!await ${has(hidden)})()`,10000);await record('native-visible-recovery-exposes');await remove([hidden]);

    // Real modal and workbench closures invalidate without a feed scroll.
    for(const kind of ['modal','workbench']){
      await anchor();const name=await publish(kind+'.png');
      await invoke('keys.panel.toggle');await reveal(name);
      if(kind==='workbench'){await invoke('workbench.openEntry',{id:'another:bulk-00035.png'});await invoke('keys.panel.close');}
      await page.poll(kind==='modal'?`!!document.querySelector('.modal-backdrop')`:`!document.querySelector('#diff').hidden`);
      assert(await page.evaluate(has(name)));const scroll=await page.evaluate(`document.querySelector('#candidatesCol').scrollTop`);
      await shot(kind+'-covered');await record(kind+'-covered-retains');
      await invoke(kind==='modal'?'keys.panel.close':'workbench.hide');await page.poll(seen(name));
      assert.equal(await page.evaluate(`document.querySelector('#candidatesCol').scrollTop`),scroll);await record(kind+'-close-exposes-without-scroll');await remove([name]);
    }

    // A partial native source popup covers just this tiny loaded image. Its
    // visibility change must expose it without scrolling or a global veto.
    await page.send('Emulation.setDeviceMetricsOverride',{width:800,height:900,deviceScaleFactor:1,mobile:false});await anchor();
    const popup=await publish('popup.png',{width:20,height:20});await invoke('keys.panel.toggle');await reveal(popup);await invoke('source.menu.open');
    await page.evaluate(`(()=>{const image=document.querySelector('.card[data-name="${popup}"] img'),menu=document.querySelector('#hostDrop'),col=document.querySelector('#candidatesCol');const a=image.getBoundingClientRect(),b=menu.getBoundingClientRect();col.scrollTop+=(a.top+a.height/2)-(b.top+b.height/2);})()`);await frame();
    const popupGeometry=await page.evaluate(`(()=>{const a=document.querySelector('.card[data-name="${popup}"] img').getBoundingClientRect(),b=document.querySelector('#hostDrop').getBoundingClientRect();return {covered:a.left>=b.left&&a.right<=b.right&&a.top>=b.top&&a.bottom<=b.bottom,scroll:document.querySelector('#candidatesCol').scrollTop};})()`);
    assert(popupGeometry.covered,'actual native popup fully covers the media rectangle');await invoke('keys.panel.close');await frame();assert(await page.evaluate(has(popup)));
    await shot('popup-covered');await record('partial-popup-only-covered-media-retains',popupGeometry);await invoke('source.menu.close');await page.poll(seen(popup));
    assert.equal(await page.evaluate(`document.querySelector('#candidatesCol').scrollTop`),popupGeometry.scroll);await record('popup-close-exposes-without-scroll');await remove([popup]);
    await page.send('Emulation.setDeviceMetricsOverride',{width:1400,height:900,deviceScaleFactor:1,mobile:false});
    }

    // A sticky foot is a genuine painted occluder, not the whole card box.
    if(!['failed','single'].includes(process.env.E2E_MATRIX_FROM)){
    await anchor();const sticky=await publish('sticky.png',{width:20,height:20});await invoke('keys.panel.toggle');await reveal(sticky);
    await page.evaluate(`(()=>{const card=document.querySelector('.card[data-name="${sticky}"]'),a=card.querySelector('img').getBoundingClientRect(),b=card.querySelector('.card-foot').getBoundingClientRect(),col=document.querySelector('#candidatesCol');col.scrollTop+=(a.top+a.height/2)-(col.getBoundingClientRect().bottom-b.height/2);})()`);await frame();
    const foot=await page.evaluate(`(()=>{const card=document.querySelector('.card[data-name="${sticky}"]'),a=card.querySelector('img').getBoundingClientRect(),b=card.querySelector('.card-foot').getBoundingClientRect();return {covered:a.left>=b.left&&a.right<=b.right&&a.top>=b.top&&a.bottom<=b.bottom};})()`);assert(foot.covered,'sticky foot fully covers native image');
    await invoke('keys.panel.close');await frame();assert(await page.evaluate(has(sticky)));await record('sticky-foot-covered-retains',foot);await reveal(sticky);await page.poll(seen(sticky));await remove([sticky]);
    }

    // Failed decode cannot acknowledge; authoritative removal clears attention.
    if(process.env.E2E_MATRIX_FROM!=='single'){
    await anchor();const failed=await publish('failed.png',{fixture:'undecodable',width:undefined,height:undefined});await reveal(failed,{loaded:false});
    await page.poll(`!!document.querySelector('.card[data-name="${failed}"] .media-failure')`,20000);assert(await page.evaluate(has(failed)));await record('failed-decode-retains');await remove([failed]);await quiet();

    // Paused audio uses the actual painted face, never playback completion.
    await anchor();const audio=await publish('audio.wav',{fixture:'media/workflow.wav',width:undefined,height:undefined});await invoke('keys.panel.toggle');await reveal(audio);
    assert(await page.evaluate(has(audio)));assert(await page.evaluate(`document.querySelector('.card[data-name="${audio}"] audio').paused`));await invoke('keys.panel.close');await page.poll(seen(audio));await record('painted-paused-audio-exposes');await remove([audio]);
    }

    // A one-row filtered view has no visible rail but still shares attention.
    await anchor();const single=await publish('one-row.png');await invoke('keys.panel.toggle');await reveal(single);await page.evaluate(`(async()=>${KZ}.actions.ui.setFilter(${JSON.stringify(single)}))()`);
    await page.poll(`(async()=>${KZ}.state.view().length===1)()`);await page.poll(`!!document.querySelector('.card[data-name="${single}"]')`);await frame();
    assert(await page.evaluate(has(single)));assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('#feedRail')).visibility`),'hidden');
    await invoke('keys.panel.close');await page.poll(seen(single));await record('one-row-shared-owner-exposes');await page.evaluate(`(async()=>${KZ}.actions.ui.setFilter(''))()`);await remove([single]);

    // Decode actual favicon pixels and restore all original attributes.
    await anchor();const hiddenByDelete=await publish('hidden-by-delete.png');await page.poll(has(hiddenByDelete));
    await invoke('image.delete.request',{id:'another:'+hiddenByDelete});
    // ConfirmDelete owns successful modal closure around the semantic writer.
    await page.clickAt('#confirmPanel .confirm-ok');await page.poll(`!document.querySelector('#confirmOverlay')`);await quiet();
    assert.deepEqual(await page.evaluate(`(()=>{const l=document.querySelector('link[rel="icon"]');return {href:l.getAttribute('href'),type:l.getAttribute('type'),sizes:l.getAttribute('sizes')};})()`),original);
    await record('last-unseen-hide-command-clears-source-and-favicon');await remove([hiddenByDelete]);
    await anchor();const icon=await publish('favicon.png');await page.poll(attention);
    const pixel=await page.evaluate(`(async()=>{const image=new Image();image.src=document.querySelector('link[rel="icon"]').href;await image.decode();const c=document.createElement('canvas');c.width=c.height=64;const x=c.getContext('2d');x.drawImage(image,0,0,64,64);return {dot:[...x.getImageData(50,14,1,1).data],separator:[...x.getImageData(50,1,1,1).data]};})()`);
    assert.deepEqual(pixel.dot,[255,102,102,255]);assert.deepEqual(pixel.separator,[255,255,255,255]);await shot('unseen-selected-source');await record('favicon-native-pixels',pixel);
    await reveal(icon);await quiet();assert.deepEqual(await page.evaluate(`(()=>{const l=document.querySelector('link[rel="icon"]');return {href:l.getAttribute('href'),type:l.getAttribute('type'),sizes:l.getAttribute('sizes')};})()`),original);
    await shot('all-seen');await record('last-exposure-restores-all-favicon-attributes');await remove([icon]);
    await page.goto(ENGINE+'/#another');await page.evaluate('window.__unseenReloadProbe=true');await page.send('Page.reload');
    await page.poll(`(async()=>document.readyState==='complete'&&window.__unseenReloadProbe===undefined&&${KZ}.state.sourceDelivery()==='ready'&&!${KZ}.state.inventory.loading)()`,20000);assert.equal(await page.evaluate(attention),false);await record('reload-quiet-baseline');
    console.log('PASS '+records.length+' real unseen matrix consumer outcomes');return records;
  }catch(error){await shot('failure');await record('FAIL',{error:error.message});throw error;}
}
module.exports={run};
if(require.main===module)(async()=>{const page=await CDP.launch(9355,{windowSize:'1600,1200'}),errors=await collectPageErrors(page);try{await run(page);assert.deepEqual(errors,[],'zero uncaught page errors');}finally{fs.writeFileSync(path.join(process.env.E2E_EVIDENCE,'page-errors.json'),JSON.stringify(errors,null,2));await page.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
