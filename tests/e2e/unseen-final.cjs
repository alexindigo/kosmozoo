const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {CDP,collectPageErrors}=require('./cdp.cjs');
const ENGINE=process.env.E2E_ENGINE??'http://127.0.0.1:20480',KZ='(await import("/store/instance.js")).appStore';
async function run(page){
  const root=process.env.E2E_EVIDENCE,checks=[],shots=path.join(root,'shots');fs.mkdirSync(shots,{recursive:true});
  const capture=async(p,name)=>{const image=await p.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(shots,name+'.png'),Buffer.from(image.data,'base64'));};
  const check=(name,ok,detail)=>{checks.push({name,ok,detail});fs.writeFileSync(path.join(root,'checks.json'),JSON.stringify(checks,null,2));assert(ok,name+(detail?' '+detail:''));console.log('ok '+name);};
  const other=new URL(process.env.E2E_FAKE??'http://127.0.0.1:20482'),fake=new URL(other);fake.port=String(Number(fake.port)-1);
  await page.goto(ENGINE+'/#fixture-dir');await page.poll(`(async()=>${KZ}.state.sourceDelivery()==='ready'&&!${KZ}.state.inventory.loading)()`,20000);
  await require('./source-new-content.cjs')({page,ENGINE,FAKE:fake.origin,KZ,check,capture});
  await require('./judgment-colors.cjs').run({page,engine:ENGINE,evidence:path.join(root,'judgment'),shots:path.join(shots,'judgment')});
  check('full positive judgment body/button/border and stable geometry: ten cases',true);
  // Persistent segments preserve treatment while the actual media stays covered.
  const run=require('node:crypto').randomUUID(),name=`treatment/${run}/unseen.png`,id='another:'+name;
  const control=async body=>{const r=await fetch(other.origin+'/__test/activity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200);await r.json();};
  await page.evaluate(`(async()=>{const s=${KZ};await s.actions.hosts.select('another');s.actions.ui.setFilter('');s.actions.folders.select('');const i=s.state.images.findIndex(e=>e.filename==='bulk-00035.png');s.actions.current.set('another','bulk-00035.png');s.actions.feed.restoreToIndex(i);})()`);
  await control({publish:[{name,fixture:'flux-basic.png',width:150,height:90,mtime:1}]});await page.evaluate(`(async()=>${KZ}.actions.ui.refresh())()`);
  await page.poll(`(async()=>${KZ}.state.entryHasNew(${JSON.stringify(id)}))()`);await page.evaluate(`(async()=>${KZ}.handles.invoke('keys.panel.toggle'))()`);
  assert.equal(await page.evaluate(`(async()=>${KZ}.handles.invoke('entry.navigate',{source:'another',file:${JSON.stringify(name)}}))()`),true);
  await page.poll(`document.querySelector('.card[data-name="${name}"] .media-box')?.classList.contains('ic-loaded')`,20000);
  await page.poll(`(()=>{const body=document.querySelector('.fr-tick[data-entry-id="${id}"] .fr-body');return body&&body.getAnimations().every(a=>a.playState==='finished');})()`);
  const records=[];let geometry;
  try{
    for(const [kind,patch,color] of [['up',{vote:'up'},'rgb(158, 206, 106)'],['down',{vote:'down'},'rgb(255, 102, 102)'],['bookmark',{vote:'up',bookmark:true},'rgb(56, 189, 248)'],['favorite',{vote:'up',bookmark:true,favorite:true},'rgb(255, 136, 0)']]){
      await page.evaluate(`(async()=>${KZ}.handles.invoke('judgment.apply',{id:${JSON.stringify(id)},intent:{type:'set',patch:{vote:null,favorite:null,bookmark:null,...${JSON.stringify(patch)}}}}))()`);
      const actual=await page.poll(`(()=>{const tick=document.querySelector('.fr-tick[data-entry-id="${id}"]'),card=document.querySelector('.card[data-name="${name}"]');if(!tick||!card)return false;const body=tick.querySelector('.fr-body'),segment=tick.querySelector('.fr-unseen'),b=body.getBoundingClientRect(),u=segment.getBoundingClientRect(),t=tick.getBoundingClientRect();return {unseen:tick.classList.contains('unseen'),treatment:tick.dataset.treatment,body:getComputedStyle(body).backgroundColor,segment:getComputedStyle(segment).backgroundColor,border:getComputedStyle(card).borderTopColor,width:t.width,height:t.height,bodyWidth:b.width,segmentWidth:u.width,adjacency:u.left-b.right,bodyTop:b.top,segmentTop:u.top,bodyHeight:b.height,segmentHeight:u.height};})()`);
      assert(actual.unseen);assert.equal(actual.treatment,kind);assert.equal(actual.body,color);assert.equal(actual.border,color);assert.equal(actual.segment,'rgb(245, 197, 66)');assert(Math.abs(actual.adjacency)<.1);assert.equal(actual.bodyTop,actual.segmentTop);assert.equal(actual.bodyHeight,actual.segmentHeight);assert(Math.abs(actual.segmentWidth/actual.width-1/3)<.06);
      geometry??={width:actual.width,height:actual.height};assert.deepEqual({width:actual.width,height:actual.height},geometry);records.push({kind,...actual});
    }
    await capture(page,'treated-unseen');await page.evaluate(`(async()=>${KZ}.handles.invoke('keys.panel.close'))()`);await page.poll(`(async()=>!${KZ}.state.entryHasNew(${JSON.stringify(id)}))()`);
    fs.writeFileSync(path.join(root,'treated-unseen.json'),JSON.stringify(records,null,2));check('treated/current unseen segment preserves all body priorities and structural geometry',true);
  }finally{await control({remove:[name]});await page.evaluate(`(async()=>${KZ}.actions.ui.refresh())()`);}
  console.log('PASS qualified pulse/reduced-motion/full-green/treated-unseen consumers');
}
module.exports={run};
if(require.main===module)(async()=>{const page=await CDP.launch(9357,{windowSize:'1600,1200'}),errors=await collectPageErrors(page);try{await run(page);assert.deepEqual(errors,[]);}catch(e){const image=await page.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(process.env.E2E_EVIDENCE,'failure.png'),Buffer.from(image.data,'base64'));throw e;}finally{fs.writeFileSync(path.join(process.env.E2E_EVIDENCE,'page-errors.json'),JSON.stringify(errors));await page.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
