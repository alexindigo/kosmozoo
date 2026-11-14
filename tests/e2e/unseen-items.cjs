// Complete current-source unseen consumer path, driven through real source IO.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { workPath } = require('./paths.cjs');
const ENGINE = process.env.E2E_ENGINE ?? 'http://127.0.0.1:20480';
const FAKE = process.env.E2E_FAKE ?? 'http://127.0.0.1:20481';
const KZ = '(await import("/store/instance.js")).appStore';
const JOB = `${process.env.E2E_CASE_ID ?? 'unseen-early'}-${require('node:crypto').randomUUID()}`;
const OUTPUTS = [`unseen/${JOB}-a.png`, `unseen/${JOB}-b.png`];
async function run(page, { nativeViewport = false, captureFull } = {}) {
  const out = process.env.E2E_EVIDENCE ?? workPath('artifacts/unseen-items');
  const shots = process.env.E2E_SHOTS ?? path.join(out, 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const records = [];
  const record = async name => {
    const value = await page.evaluate(`(async()=>{const s=${KZ};const card=[...document.querySelectorAll('.card')].find(e=>e.dataset.name===window.unseenAnchor);
      const ids=${JSON.stringify(OUTPUTS)};return {visibility:document.visibilityState,host:s.state.host(),current:s.state.current(),url:location.href,
      anchorTop:card?.getBoundingClientRect().top,source:document.querySelector('.pinned-source[data-source="another"]')?.classList.contains('has-new'),
      favicon:document.querySelector('link[rel="icon"]')?.getAttribute('href'),items:ids.map(name=>{const tick=document.querySelector('.fr-tick[data-entry-id="another:'+name+'"]');
        return {name,unseen:tick?.classList.contains('unseen'),color:tick&&getComputedStyle(tick.querySelector('.fr-unseen')??tick).backgroundColor};})};})()`);
    records.push({name,job:JOB,outputs:OUTPUTS,...value});
    const image=await page.send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(shots,name+'.png'),Buffer.from(image.data,'base64'));
    fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(records,null,2));
    await captureFull?.(name, value);
    return value;
  };
  const other = new URL(FAKE); other.port=String(Number(other.port)+1);
  const control=async body=>{const r=await fetch(other.origin+'/__test/activity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200);await r.json();};
  const owned = require('./owned-fixtures.cjs').fakeFixtures(other.origin, control);
  const reveal=async name=>{
    await page.poll(`(async()=>{const s=${KZ};return s.state.entriesWithKnownSize().some(i=>s.state.images[i].filename===${JSON.stringify(name)});})()`,20000);
    await page.evaluate(`(async()=>{const s=${KZ};const i=s.state.images.findIndex(e=>e.filename===${JSON.stringify(name)});if(i<0)throw Error('missing arrival');s.actions.feed.restoreToIndex(i);})()`);
    await page.poll(`(()=>{const el=document.querySelector('.card[data-name="${name}"] .imgwrap img');const v=document.querySelector('#candidatesCol').getBoundingClientRect();const r=el?.getBoundingClientRect();return el?.complete&&el.naturalWidth>0&&r.bottom>v.top&&r.top<v.bottom;})()`,20000);
  };
   await owned.run(async () => {
  if(!nativeViewport)await page.send('Emulation.setDeviceMetricsOverride',{width:1400,height:900,deviceScaleFactor:1,mobile:false});
  await page.goto(ENGINE+'/#another');
  await page.poll(`(async()=>{const s=${KZ};return s.state.host()==='another'&&!s.state.inventory.loading&&s.state.entriesWithKnownSize().length>30;})()`,20000);
  await page.evaluate(`(async()=>{const s=${KZ};s.actions.diff.hide();s.actions.ui.setFilter('');await s.actions.hosts.patch('another',{pinned:true,autoRefresh:true});
    const known=s.state.entriesWithKnownSize();const i=known[Math.floor(known.length/2)];window.unseenAnchor=s.state.images[i].filename;s.actions.current.set('another',window.unseenAnchor);s.actions.feed.restoreToIndex(i);})()`);
  await page.poll(`(()=>{const e=document.querySelector('.card[data-name="'+window.unseenAnchor+'"] .imgwrap img');return e?.complete&&e.naturalWidth>0;})()`,20000);
  await new Promise(resolve=>setTimeout(resolve,400));
  const before=await record('baseline');
  await owned.start(JOB);
  await page.poll(`(async()=>${KZ}.state.sourceActivity.another?.runningPromptId===${JSON.stringify(JOB)})()`,20000);
  await owned.finish(JOB, OUTPUTS.map(output=>({output,width:150,height:90,mtime:1})));
  await page.poll(`(async()=>${KZ}.state.images.some(e=>e.filename===${JSON.stringify(OUTPUTS[1])}))()`,25000);
  await page.poll(`!!document.querySelector('.fr-tick[data-entry-id="another:${OUTPUTS[1]}"]')`,20000);
  await new Promise(resolve=>setTimeout(resolve,1700));
  const retained=await record('offscreen-retained');
  assert.equal(retained.source,true,'selected source retains off-screen unseen attention');
  assert(retained.items.every(e=>e.unseen),'both off-screen ticks stay unseen beyond pulse');
  assert(retained.favicon.startsWith('data:image/png'),'favicon receives aggregate attention');
  assert.deepEqual(retained.current,before.current);assert.equal(retained.url,before.url);
  assert(Math.abs(retained.anchorTop-before.anchorTop)<=1,'anchored viewport retained');
  await reveal(OUTPUTS[0]);
  await page.poll(`(async()=>!${KZ}.state.entryHasNew(${JSON.stringify('another:'+OUTPUTS[0])}))()`,10000);
  const partial=await record('exact-first-exposure');
  assert.equal(partial.items[0].unseen,false);assert.equal(partial.items[1].unseen,true);assert.equal(partial.source,true);
  await reveal(OUTPUTS[1]);
  await page.poll(`!document.querySelector('.pinned-source[data-source="another"]').classList.contains('has-new')`,10000);
  const clear=await record('all-exposed');
  assert.equal(clear.favicon,before.favicon);assert(clear.items.every(e=>!e.unseen));
  console.log('PASS current-source off-screen tick/source/favicon retention and exact exposure clearing');
  });
}
module.exports={run};
if(require.main===module)(async()=>{const page=await CDP.launch(9353,{windowSize:'1600,1200'});const errors=await collectPageErrors(page);
  try{await run(page);assert.deepEqual(errors,[],'zero uncaught page errors');}
  catch(error){const out=process.env.E2E_EVIDENCE; if(out){fs.mkdirSync(out,{recursive:true});
    fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({error:error.message,errors,model:await page.evaluate(`(async()=>{const s=${KZ};return {delivery:s.state.sourceDelivery(),inventory:s.state.inventory,activity:s.state.sourceActivity,images:s.state.images.filter(e=>e.filename.startsWith('unseen/')),source:s.state.sourceHasNew('another')}})()`)},null,2));
    const shot=await page.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'failure.png'),Buffer.from(shot.data,'base64'));}throw error;
  }finally{await page.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
