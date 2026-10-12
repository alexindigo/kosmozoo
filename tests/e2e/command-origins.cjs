const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CDP } = require('./cdp.cjs');
const { workPath } = require('./paths.cjs');
module.exports = async ({ page, ENGINE, KZ, check }) => {
  const invoke = (id,args={}) => page.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const rendered = () => page.evaluate(`(async()=>{const s=${KZ};return{mode:s.state.diff.mode,col:s.state.diff.col,locked:s.state.diff.locked,
    pill:document.querySelector('#diffModes .on')?.title,left:document.querySelector('.dz-sidebtn')?.textContent,
    lock:document.querySelector('.dz-lockbtn')?.getAttribute('aria-pressed'),url:location.href,current:s.state.current()}})()`);
  await invoke('source.select',{id:'fake'});
  await invoke('feed.filter',{value:''}); await invoke('source.folder',{folder:''});
  await invoke('workbench.openPair',{left:{source:'fake',file:'flux-basic.png'},right:{source:'fake',file:'flux-lora.png'},push:true});
  await page.poll(`!!document.querySelector('#diffModes')`);
  const portIdentity=await page.evaluate(`(async()=>{const s=${KZ},port=s.handles.get('workbench.mode');return port===s.handles.get('workbench.mode') && !('execute' in port)})()`);
  assert(portIdentity);
  await invoke('workbench.mode',{mode:'split'}); const programmatic=await rendered();
  await invoke('workbench.mode',{mode:'two-up'});
  await page.clickAt('#diffModes button[title="Split (3)"]');
  await page.poll(`(async()=>${KZ}.state.diff.mode==='split')()`);
  assert.deepEqual(await rendered(),programmatic);
  await invoke('workbench.mode',{mode:'two-up'});
  await page.keyTrusted('3',{vk:51}); await page.poll(`(async()=>${KZ}.state.diff.mode==='split')()`);
  assert.deepEqual(await rendered(),programmatic);
  await invoke('workbench.column',{column:'right'});
  await invoke('workbench.lock',{value:false});
  const unlocked=await rendered();
  await page.clickAt('.dz-lockbtn'); await page.keyTrusted('l',{vk:76});
  await page.poll(`(async()=>!${KZ}.state.diff.locked)()`);
  assert.deepEqual(await rendered(),unlocked);
  const before=(await rendered()).current;
  await page.keyTrusted('ArrowLeft',{vk:37}); await page.keyTrusted('ArrowDown',{vk:40});
  await page.poll(`(async()=>${KZ}.state.current()?.image!==${JSON.stringify(before.image)})()`);
  assert((await rendered()).url.includes('#fake#'));
  check('commands: trusted key/pointer/handle render the same comparison; step reaches current and URL',true);
  await invoke('workbench.close');

  // Browser downloads prove JSON bytes at the consumer, not just an href/spy.
  // Own the download producer for exactly the lifetime of its private output.
  const resourcePage=await CDP.launch(9349);
  const directory=fs.mkdtempSync(workPath('tests/.tmp-command-downloads-'));
  try {
    await resourcePage.goto(ENGINE+'/#fake');
    await resourcePage.poll(`(async()=>${KZ}.state.images.length>0)()`);
    await resourcePage.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:directory});
    await resourceProof(resourcePage);
  } finally {
    await resourcePage.close();
    fs.rmSync(directory,{recursive:true,force:true});
  }

  async function resourceProof(page) {
  const invoke = (id,args={}) => page.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const waitFile=async name=>{
    const until=Date.now()+10000;
    while(Date.now()<until){const path=directory+'/'+name;if(fs.existsSync(path))return JSON.parse(fs.readFileSync(path,'utf8'));await new Promise(r=>setTimeout(r,50));}
    throw new Error('download did not reach consumer: '+name);
  };
  const expected=async source=>(await(await fetch(`${ENGINE}/api/collections/${encodeURIComponent(source)}/feedback.json`)).json());
  const expectDownload=async source=>{
    const actual=await waitFile(`kosmozoo_${source}_feedback.json`), reference=await expected(source);
    assert(Number.isFinite(Date.parse(actual.generated_at)),'download has a valid on-demand generation time');
    assert.deepEqual(actual,{...reference,generated_at:actual.generated_at});
    if(source==='fake')assert(Object.keys(actual.entries).length>0,'download includes actual persisted judgments');
  };
  let originalBookmark;
  try{
    await invoke('source.select',{id:'fake'});
    originalBookmark=await page.evaluate(`(async()=>${KZ}.state.images.find(i=>i.id==='fake:flux-basic.png').judgment?.bookmark??null)()`);
    await invoke('judgment.apply',{id:'fake:flux-basic.png',intent:{type:'set',patch:{bookmark:true}}});
    await page.clickAt('#menuBtn'); await page.poll(`!!document.querySelector('#menu .btn')`);
    await page.clickAt('#menu .btn');
    await expectDownload('fake');
    assert.equal(fs.readdirSync(directory).length,1,'primary native link must not double-download');
    await invoke('menu.close');
    await page.clickAt('#hostBtn'); await page.poll(`!document.querySelector('#hostDrop').hidden`);
    await page.clickAt('.hostpick[data-source="another"] .dl');
    await expectDownload('another');
    assert.equal(await page.evaluate(`(async()=>${KZ}.state.host())()`),'fake','originating source captured independently of current');
    assert(await page.evaluate(`(async()=>${KZ}.state.hostMenuOpen())()`),'row click is isolated');
    const attrs=await page.evaluate(`(()=>{const a=document.querySelector('.hostpick[data-source="another"] .dl');return{href:a.getAttribute('href'),download:a.download,icon:!!a.querySelector('svg')}})()`);
    assert.deepEqual(attrs,{href:'/api/collections/another/feedback.json',download:'kosmozoo_another_feedback.json',icon:true});
    await invoke('source.menu.close');
    await invoke('collection.feedback.download',{source:'fixture-dir'});
    await expectDownload('fixture-dir');
    check('commands: both native feedback affordances and unbound handle deliver originating collection JSON bytes',true);
    // Native modified/new-tab/auxiliary/context behavior stays uncancelled.
    await invoke('source.menu.toggle');
    assert(await page.evaluate(`(()=>{const a=document.querySelector('.hostpick[data-source="another"] .dl');return ['click','auxclick','contextmenu'].every(type=>a.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,button:type==='click'?0:1,ctrlKey:true})))})()`));
    check('commands: feedback retains href/download and modified/auxiliary/context native fallback',true);
  }finally{
    if(originalBookmark!==undefined)await invoke('judgment.apply',{id:'fake:flux-basic.png',intent:{type:'set',patch:{bookmark:originalBookmark}}});
    await invoke('source.menu.close');
  }
  }
};
