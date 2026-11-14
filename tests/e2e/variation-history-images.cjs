const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { addParameter } = require('./variation-add-helpers.cjs');
module.exports = async ({page,evaluate,invoke,list,write,ENGINE,FAKE,E,phase,shot}) => {
  const root='/work/runtime/history-fixtures';
  const files=[root+'/repeat-1/same.png',root+'/repeat-2/same.png',...Array.from({length:78},(_,i)=>root+'/images/image-'+String(i+3).padStart(2,'0')+'.png')];
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const chooseFiles = async paths => {
    const {root:doc}=await page.send('DOM.getDocument');
    const {nodeId}=await page.send('DOM.querySelector',{nodeId:doc.nodeId,selector:'[data-image-id="43.image"] input[type=file]'});
    await page.send('DOM.setFileInputFiles',{nodeId,files:paths});
    await page.poll(`document.querySelectorAll('[data-image-id="43.image"] [data-image-kind="upload"]').length===${paths.length}`,30000);
  };
  const open = async () => {
    await evaluate(`fetch('/api/collections/fake/entries/flux-controlnet.png/bytes')`);
    await invoke('variations.open',{id:'fake:flux-controlnet.png'}); await addParameter(page,'43.image'); await addParameter(page,'9.denoise');
    await page.clickAt('[data-param-key="9.denoise"] .mode-switch button[title="Value"]'); await write('[data-param-key="9.denoise"] .vz-value-field input','0.9');
    await page.clickAt('[data-image-id="43.image"] [data-image-kind="reference"] .vz-image-remove button');
  };
  const submit = async expected => {
    await page.clickAt('.vz-run');
    await page.poll(`document.querySelector('.vz-queued')?.textContent==='Queued ${expected} of ${expected} jobs'||!!document.querySelector('.vz-error')?.textContent`,90000);
    assert.equal(await page.evaluate('document.querySelector(".vz-queued")?.textContent'),`Queued ${expected} of ${expected} jobs`,await page.evaluate('document.querySelector(".vz-error").textContent'));
    await invoke('variations.close'); await page.poll('!document.querySelector(".vz-panel")');
  };
  if(phase!=='recall'){
    await fetch(FAKE+'/__test/activity',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({captureEnqueue:true})});
    await open(); await chooseFiles([root+'/single.png']); await submit(1);
    const one=(await list()).items[0];
    await open(); await chooseFiles(files); await submit(80);
    const saved=(await list()).items.find(row=>row.summary.total===80); assert(saved);
    const detail=await evaluate(`fetch('/api/features/variations/history/${saved.id}').then(r=>r.json())`);
    assert.equal(detail.recipe.images['43.image'].values.items.length,80);
    const expected=files.map(path=>hash(fs.readFileSync(path)));
    for(let i=0;i<80;i++)assert.equal(detail.resources.find(r=>r.id===detail.recipe.images['43.image'].values.items[i].resourceId).hash,expected[i]);
    fs.writeFileSync(E+'/record.json',JSON.stringify({id:saved.id,oneId:one.id,snapshotHash:detail.snapshotHash,expected}));
    if(phase==='record')return;
  }
  const saved=JSON.parse(fs.readFileSync(E+'/record.json','utf8'));
  await page.clickAt('[data-workspace="variation-history"]'); await page.poll('document.querySelectorAll(".vh-panel .vh-entry").length===2');
  await page.poll('document.querySelector(".vh-thumbs img")?.naturalWidth>0'); await shot('one-and-80-images');
  await page.clickAt(`[data-history-id="${saved.id}"] .vh-inspect`);
  await page.poll('document.querySelectorAll(".vh-contact-tile").length>0');
  await page.poll('document.querySelector(".vh-contact-tile img")?.naturalWidth>0'); await shot('images-expanded');
  assert(await page.evaluate('document.querySelectorAll(".vh-contact-tile").length<50'),'contact sheet is virtualized, not an eager 80-image burst');
  await page.evaluate('document.querySelector(".vh-contact").scrollTop=document.querySelector(".vh-contact").scrollHeight');
  await page.poll('document.querySelector(".vh-contact-tile[data-image-index=\\"80\\"] img")?.naturalWidth>0',30000);
  await page.clickAt(`[data-history-id="${saved.id}"] .vh-recall`); await page.poll('document.querySelectorAll("[data-image-kind=\\"archive\\"]").length===80');
  assert.equal(await page.evaluate('document.querySelectorAll("[data-image-kind=\\"upload\\"]").length'),0,'restore uses lazy archive handles, not downloaded Files');
  await page.clickAt('.vh-trigger'); await page.poll('!!document.querySelector(".vh-menu")?.matches(":popover-open")'); await shot('image-dropdown'); await page.clickAt('.vh-trigger');
  await submit(80);
  const jobs=await(await fetch(FAKE+'/__test/enqueues')).json(); assert.equal(jobs.length,161);
  for(let i=0;i<80;i++){
    const name=jobs[81+i].prompt['43'].inputs.image;
    const bytes=await(await fetch(FAKE+'/api/view?type=input&filename='+encodeURIComponent(name))).arrayBuffer();
    assert.equal(hash(Buffer.from(bytes)),saved.expected[i],'actual backend image assignment '+(i+1));
  }
  assert.equal((await list()).items.length,3);
  const original=await evaluate(`fetch('/api/features/variations/history/${saved.id}').then(r=>r.json())`);
  assert.equal(original.snapshotHash,saved.snapshotHash);
  fs.writeFileSync(E+'/images-consumer.json',JSON.stringify({saved,jobs}));
  console.log('One/80 native images, repeated names, virtual image80 and archived rerun final hashes passed');
};
