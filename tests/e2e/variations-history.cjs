const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { addParameter } = require('./variation-add-helpers.cjs');
const KZ = `(await import('/store/instance.js')).appStore`;

async function run({ page, errors, ENGINE, FAKE, E, scenario, phase }) {
  await page.send('Emulation.setDeviceMetricsOverride', {width:1280,height:800,deviceScaleFactor:1,mobile:false});
  const shot = async name => {
    await page.poll(`(()=>{
      const exposed=img=>{
        if(img.closest('[inert]')||!img.checkVisibility())return false;
        const r=img.getBoundingClientRect();let left=Math.max(0,r.left),top=Math.max(0,r.top),right=Math.min(innerWidth,r.right),bottom=Math.min(innerHeight,r.bottom);
        for(let p=img.parentElement;p;p=p.parentElement){const s=getComputedStyle(p),b=p.getBoundingClientRect();
          if(/auto|scroll|hidden|clip/.test(s.overflowX)){left=Math.max(left,b.left);right=Math.min(right,b.right)}
          if(/auto|scroll|hidden|clip/.test(s.overflowY)){top=Math.max(top,b.top);bottom=Math.min(bottom,b.bottom)}
        }
        if(right<=left||bottom<=top)return false;
        const surface=img.closest('.vz-thumbnail')??img;
        return [[.5,.5],[.1,.1],[.9,.1],[.1,.9],[.9,.9]].some(([x,y])=>surface.contains(document.elementFromPoint(left+(right-left)*x,top+(bottom-top)*y)));
      };
      return [...document.querySelectorAll('.vh-thumbs img,.vh-contact-tile img,.vz-catalogue-picture img')].filter(exposed).every(img=>img.complete&&img.naturalWidth>0);
    })()`,30000);
    await page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const {data}=await page.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(E+'/'+name+'.png',Buffer.from(data,'base64'));
    const regions=await page.evaluate(`(()=>{const out=[];for(const [name,selector]of [['header','header'],['feed','#grid'],['workspace','#workspace'],['bar','#wsBar'],['title','.vz-title'],['history','.vh-tools'],['menu','.vh-menu:popover-open'],['catalogue','.vz-catalogue'],['editors','.vz-sliders'],['summary','.vz-right'],['decision','.vz-discard']]){const el=document.querySelector(selector);if(!el)continue;const r=el.getBoundingClientRect(),x=Math.max(0,r.left),y=Math.max(0,r.top),right=Math.min(innerWidth,r.right),bottom=Math.min(innerHeight,r.bottom);if(right>x&&bottom>y)out.push({name,clip:{x,y,width:right-x,height:bottom-y,scale:2}})}return out})()`);
    fs.mkdirSync(E+'/review/'+name,{recursive:true});
    for(const region of regions){const {data}=await page.send('Page.captureScreenshot',{format:'png',clip:region.clip});fs.writeFileSync(E+'/review/'+name+'/'+region.name+'.png',Buffer.from(data,'base64'))}
  };
  const evaluate = expression => page.evaluate(`(async()=>(${expression}))()`);
  const invoke = (command, args = {}) => evaluate(`${KZ}.handles.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
  const list = () => evaluate(`fetch('/api/features/variations/history').then(r=>r.json())`);
  const write = async (selector, value) => {
    await page.clickAt(selector); await page.evaluate('document.activeElement.select()');
    await page.send('Input.insertText', { text: value });
    await page.poll(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(value)}`);
  };
  const waitRun = async () => {
    await page.clickAt('.vz-run');
    await page.poll('document.querySelector(".vz-queued")?.textContent.includes("Queued 1 of 1") || !!document.querySelector(".vz-error")?.textContent', 30000);
    const message = await page.evaluate('document.querySelector(".vz-error").textContent');
    assert(!message || message.startsWith('submitted'), message);
  };
  const panel = async () => {
    if (await page.evaluate('!!document.querySelector(".vz-panel")')) { await invoke('variations.close'); await page.poll('!document.querySelector(".vz-panel")'); }
    await page.clickAt('[data-workspace="variation-history"]');
    await page.poll('document.querySelectorAll(".vh-panel .vh-entry").length>0');
  };
  await page.goto(ENGINE + '/#fake#flux-controlnet.png');
  await page.poll('!!document.querySelector(".card .variations")', 20000);
  if (scenario === 'images') {
    await require('./variation-history-images.cjs')({page,evaluate,invoke,list,write,ENGINE,FAKE,E,phase,shot}); assert.deepEqual(errors,[]); return;
  }
  if (scenario === 'bulk') {
    await require('./variation-history-bulk.cjs')({page,evaluate,invoke,list,write,ENGINE,FAKE,E,shot}); assert.deepEqual(errors,[]); return;
  }
  if (phase !== 'recall') {
    await fetch(FAKE + '/__test/activity', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({captureEnqueue:true}) });
    await evaluate(`fetch('/api/collections/fake/entries/flux-controlnet.png/bytes')`);
    await invoke('variations.open', { id: 'fake:flux-controlnet.png' });
    await addParameter(page, '9.denoise');
    await page.clickAt('[data-param-key="9.denoise"] .mode-switch button[title="Value"]');
    await write('[data-param-key="9.denoise"] .vz-value-field input', '0.9');
    await write('.vz-prefix', 'history_');
    if (scenario === 'mismatch') {
      const strength = await page.evaluate(`[...document.querySelectorAll('[data-catalogue-id]')].map(el=>el.dataset.catalogueId).find(id=>id.endsWith('.strength'))`);
      assert(strength, 'fixture exposes the extra strength input');
      await addParameter(page, strength); await page.clickAt(`[data-param-key="${strength}"] .mode-switch button[title="Value"]`);
    }
    await page.poll('document.querySelector(".vz-count").textContent==="1"');
    await waitRun();
    const saved = await list();
    assert.equal(saved.items.length, 1, JSON.stringify(saved));
    const detail = await evaluate(`fetch('/api/features/variations/history/${saved.items[0].id}').then(r=>r.json())`);
    fs.writeFileSync(E + '/record.json', JSON.stringify({ id:saved.items[0].id, snapshotHash:detail.snapshotHash }));
    assert.equal(detail.recipe.numeric['9.denoise'].values.value, '0.9');
    assert.equal(detail.outcome, 'submitted');
    console.log('UI Run saved one immutable complete configuration with accepted effects');
    if (phase === 'record') return;
  }
  const saved = await list();
  const original = JSON.parse(fs.readFileSync(E + '/record.json', 'utf8'));
  if (['mismatch','guards','recovery','deletion','layout'].includes(scenario)) {
    await require('./variation-history-cases.cjs')({page,evaluate,invoke,list,write,panel,waitRun,ENGINE,FAKE,E,scenario,original,shot});
    assert.deepEqual(errors, []); return;
  }
  await panel();
  await page.clickAt(`[data-history-id="${original.id}"] .vh-recall`);
  await page.poll('document.querySelector("[data-param-key=\\"9.denoise\\"] .vz-value-field input")?.value==="0.9"');
  assert.equal(await page.evaluate('document.querySelector(".vz-prefix").value'), 'history_');
  assert.equal(await evaluate(`${KZ}.state.variations.images[0].filename`), 'flux-controlnet.png');
  await shot('restored-original');
  await write('[data-param-key="9.denoise"] .vz-value-field input', '0.8');
  await waitRun();
  const after = await list(); assert.equal(after.items.length, 2);
  const detail = await evaluate(`fetch('/api/features/variations/history/${original.id}').then(r=>r.json())`);
  assert.equal(detail.snapshotHash, original.snapshotHash);
  assert.equal(detail.recipe.numeric['9.denoise'].values.value, '0.9');
  const jobs = await (await fetch(FAKE + '/__test/enqueues')).json();
  assert.equal(jobs.length, 2); assert.equal(jobs[1].prompt['9'].inputs.denoise, .8);
  fs.writeFileSync(E + '/consumer.json', JSON.stringify({saved:after,jobs,originalSnapshotHash:detail.snapshotHash}));
  assert.deepEqual(errors, []);
  console.log('Original targets/full setup recalled and edited; rerun created a distinct entry and queued visible value 0.8');
}

if (require.main === module) (async () => {
  const page = await CDP.launch(19454, { windowSize: '1600,1000' });
  const errors = await collectPageErrors(page);
  try { await run({page,errors,ENGINE:process.env.E2E_ENGINE,FAKE:process.env.E2E_FAKE,E:process.env.E2E_EVIDENCE,scenario:process.env.E2E_SCENARIO,phase:process.env.E2E_PHASE}); }
  catch (error) {
    const state = await page.evaluate(`(async()=>({errors:${JSON.stringify(errors)},text:document.body.innerText,opening:${KZ}.state.variations,form:document.querySelector('.vz-panel')?.outerHTML}))()`);
    fs.writeFileSync(process.env.E2E_EVIDENCE + '/failure.json', JSON.stringify(state)); console.error(JSON.stringify(state)); throw error;
  }
  finally { await page.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
module.exports = run;
