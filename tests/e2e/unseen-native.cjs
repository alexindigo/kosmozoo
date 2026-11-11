const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {CDP,collectPageErrors}=require('./cdp.cjs');
const ENGINE=process.env.E2E_ENGINE??'http://127.0.0.1:20480',FAKE=process.env.E2E_FAKE??'http://127.0.0.1:20482',KZ='(await import("/store/instance.js")).appStore';
async function run(page){
  const run=require('node:crypto').randomUUID(),out=process.env.E2E_EVIDENCE,records=[];
  fs.mkdirSync(path.join(out,'shots'),{recursive:true});
  const invoke=(command,args={})=>page.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(command)},${JSON.stringify(args)}))()`);
  const control=async body=>{const r=await fetch(FAKE+'/__test/activity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200);await r.json();};
  const refresh=()=>page.evaluate(`(async()=>${KZ}.actions.ui.refresh())()`);
  const unseen=name=>`(async()=>${KZ}.state.entryHasNew(${JSON.stringify('another:'+name)}))()`;
  const frame=()=>page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const record=async(name,result)=>{records.push({name,...result});fs.writeFileSync(path.join(out,'native.json'),JSON.stringify({run,records},null,2));console.log('ok '+name);};
  const shot=async name=>{const image=await page.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'shots',name+'.png'),Buffer.from(image.data,'base64'));};
  const navigate=async name=>{assert.equal(await invoke('entry.navigate',{source:'another',file:name}),true);await page.poll(`document.querySelector('.card[data-name="${name}"] .media-box')?.classList.contains('ic-loaded')`,30000);await frame();};
  const anchor=async()=>{await page.evaluate(`(async()=>{const s=${KZ};s.actions.ui.setFilter('');s.actions.folders.select('');const i=s.state.images.findIndex(e=>e.filename==='bulk-00035.png');s.actions.current.set('another','bulk-00035.png');s.actions.feed.restoreToIndex(i);})()`);await frame();};
  await page.send('Emulation.setDeviceMetricsOverride',{width:1400,height:900,deviceScaleFactor:1,mobile:false});await page.goto(ENGINE+'/#another');
  await page.poll(`(async()=>${KZ}.state.sourceDelivery()==='ready'&&!${KZ}.state.inventory.loading)()`,20000);await anchor();
  try{
    const video=`native/${run}/paused.webm`;
    await control({publish:[{name:video,fixture:'media/workflow.webm',mtime:1}]});await refresh();await page.poll(unseen(video));
    await invoke('keys.panel.toggle');await navigate(video);assert(await page.evaluate(unseen(video)));
    const actual=await page.evaluate(`(()=>{const v=document.querySelector('.card[data-name="${video}"] video'),r=v.getBoundingClientRect();return {paused:v.paused,ready:v.readyState,width:r.width,height:r.height,time:v.currentTime,scroll:document.querySelector('#candidatesCol').scrollTop};})()`);
    assert(actual.paused&&actual.ready>=2&&actual.width>0&&actual.height>0);await invoke('keys.panel.close');await page.poll(`(async()=>!await ${unseen(video)})()`);
    assert.equal(await page.evaluate(`document.querySelector('#candidatesCol').scrollTop`),actual.scroll);await record('paused-video-frame-exposes-without-playback',actual);await shot('paused-video');await control({remove:[video]});await refresh();

    await page.send('Emulation.setDeviceMetricsOverride',{width:800,height:900,deviceScaleFactor:1,mobile:false});await anchor();
    const image=`native/${run}/geometry.png`;
    await control({publish:[{name:image,fixture:'flux-basic.png',width:20,height:20,mtime:1}]});await refresh();await page.poll(unseen(image));
    await invoke('keys.panel.toggle');await navigate(image);await invoke('source.menu.open');
    await page.evaluate(`(()=>{const a=document.querySelector('.card[data-name="${image}"] img').getBoundingClientRect(),b=document.querySelector('#hostDrop').getBoundingClientRect(),c=document.querySelector('#candidatesCol');c.scrollTop+=(a.top+a.height/2)-(b.top+b.height/2);})()`);await frame();
    const before=await page.evaluate(`(()=>{const e=document.querySelector('.card[data-name="${image}"] img'),a=e.getBoundingClientRect(),b=document.querySelector('#hostDrop').getBoundingClientRect();return {covered:a.left>=b.left&&a.right<=b.right&&a.top>=b.top&&a.bottom<=b.bottom,src:e.getAttribute('src'),scroll:document.querySelector('#candidatesCol').scrollTop,width:a.width};})()`);assert(before.covered);
    await invoke('keys.panel.close');await frame();assert(await page.evaluate(unseen(image)));await shot('popup-covered-before-zoom');
    await page.evaluate(`(async()=>${KZ}.actions.views.set('another:${image}',{version:2,s:12,cx:.5,cy:.5,fh:false,fv:false,rot:0},{persist:false}))()`);
    await page.poll(`(async()=>!await ${unseen(image)})()`);
    const after=await page.evaluate(`(()=>{const e=document.querySelector('.card[data-name="${image}"] img'),a=e.getBoundingClientRect(),b=document.querySelector('#hostDrop').getBoundingClientRect();return {covered:a.left>=b.left&&a.right<=b.right&&a.top>=b.top&&a.bottom<=b.bottom,src:e.getAttribute('src'),scroll:document.querySelector('#candidatesCol').scrollTop,width:a.width,menuVisible:!document.querySelector('#hostDrop').hidden};})()`);
    assert.equal(after.covered,false);assert(after.menuVisible);assert.equal(after.src,before.src);assert.equal(after.scroll,before.scroll);assert(after.width>before.width);
    await record('native-zoom-geometry-uncovers-without-scroll-or-src-reload',{before,after});await shot('popup-uncovered-after-zoom');
    await invoke('source.menu.close');await page.evaluate(`(async()=>${KZ}.actions.views.set('another:${image}',null,{persist:false}))()`);await control({remove:[image]});await refresh();
    console.log('PASS video and actual geometry consumers');
  }catch(e){await shot('failure');throw e;}
}
module.exports={run};
if(require.main===module)(async()=>{const page=await CDP.launch(9356,{windowSize:'1600,1200'}),errors=await collectPageErrors(page);try{await run(page);assert.deepEqual(errors,[]);}finally{fs.writeFileSync(path.join(process.env.E2E_EVIDENCE,'page-errors.json'),JSON.stringify(errors));await page.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
