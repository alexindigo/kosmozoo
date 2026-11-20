// Real editor -> saved journal -> address lane -> fake host. Slow replies prove
// body-written progress and overlapping responses without fabricating UI state.
const assert = require('node:assert/strict'), fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { addParameter, settledCount } = require('./variation-add-helpers.cjs');
const B = process.env.E2E_ENGINE, F = process.env.E2E_FAKE, D = process.env.E2E_EVIDENCE;
const KZ = `(await import('/store/instance.js')).appStore`;
const get = async (base, path) => { const r = await fetch(base + path); assert(r.ok, `${path}: ${r.status}`); return r.json(); };
const post = async (base, path, body) => { const r = await fetch(base + path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); assert(r.ok, `${path}: ${r.status}`); return r.json(); };
(async () => {
  fs.mkdirSync(D, {recursive:true});
  const info = await get(F, '/api/object_info');
  info.OrderNode = {input:{required:{choice:[['a','b','c'],{}]}},output:['IMAGE']};
  const names = ['first','second','third'];
  await post(F, '/__test/activity', {objectInfo:info,captureEnqueue:true,publish:names.map(name => ({name:`ordered/${name}.png`,graph:{
    n:{class_type:'OrderNode',inputs:{choice:'a'}},save:{class_type:'SaveImage',inputs:{images:['n',0],filename_prefix:`ordered/${name}`}},
  }}))});
  await post(F, '/__ordered', {delay:4000});
  const c = await CDP.launch(19793, {windowSize:'1400,900'}), errors = await collectPageErrors(c);
  const invoke = (id, args={}) => c.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const regions = {header:'.vz-header',catalogue:'.vz-catalogue',editor:'.vz-left',sidebar:'.vz-right',strip:'.vz-batch'};
  const shot = async name => {
    const image = await c.send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(`${D}/${name}.png`,Buffer.from(image.data,'base64'));
    for (const [region, selector] of Object.entries(regions)) {
      const clip = await c.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()`);
      const crop = await c.send('Page.captureScreenshot',{format:'png',clip}); fs.writeFileSync(`${D}/review-${name}-${region}.png`,Buffer.from(crop.data,'base64'));
    }
    return image.data;
  };
  const geometry = () => c.evaluate(`(()=>{const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom}};return {slot:box('.vz-run-slot'),sidebar:box('.vz-right'),strip:box('.vz-batch')}})()`);
  try {
    await c.goto(B+'/#fake#ordered%2Ffirst.png');
    await c.poll(`(async()=>${KZ}.state.images.some(image=>image.filename==='ordered/third.png'))()`,20000);
    await invoke('variations.open',{ids:names.map(name=>`fake:ordered/${name}.png`),bulk:true});
    await c.poll(`document.querySelectorAll('.vz-catalogue-row').length>0`,20000);
    await addParameter(c,'n.choice');
    await c.clickAt('[data-enum-id="n.choice"] .vz-enum-opt:nth-child(2)');
    await c.clickAt('[data-enum-id="n.choice"] .vz-enum-opt:nth-child(3)');
    await settledCount(c, '6', { and: `!document.querySelector('.vz-run').disabled`, timeout: 20000 });
    const before = await geometry(), beforePng = await shot('ordered-before');
    await c.evaluate(`(async()=>{window.orderedRun=${KZ}.handles.invoke('variations.run');return true})()`);
    await c.poll(`document.querySelector('.vz-submitting')?.textContent==='Submitting 2 / 6'`,20000);
    assert.equal(await c.evaluate(`!!document.querySelector('.vz-submit-spinner')&&!document.querySelector('.vz-run')`),true);
    const during = await geometry(), duringPng = await shot('variations-submitting');
    assert.deepEqual(during,before,'Run slot and neighboring layout remain fixed');
    const centered = await c.evaluate(`(()=>{const p=document.querySelector('.vz-submitting'),s=p.querySelector('.vz-submit-spinner').getBoundingClientRect(),t=p.querySelector('.single-line-text').getBoundingClientRect();return Math.abs((s.top+s.bottom-t.top-t.bottom)/2)<.5&&p.scrollWidth<=p.clientWidth})()`);
    assert(centered,'spinner and single-line progress share the flex centerline');
    const history = (await get(B,'/api/features/variations/history')).items[0];
    const pending = await get(B,'/api/features/variations/history/'+history.id);
    assert.deepEqual(pending.submission,{sent:2,total:6}); assert.equal(pending.summary.submitted,0);
    const result = await c.evaluate(`window.orderedRun`);
    assert.equal(result.submitted,6,JSON.stringify(result)); assert.equal(result.adopted,true);
    const requests = (await get(F,'/__ordered')).requests;
    const order = requests.map(request=>{const job=JSON.parse(request.body);return [job.extra_data.extra_pnginfo.kz_origin,job.prompt.n.inputs.choice]});
    const jobs = await get(F,'/__test/enqueues');
    assert.deepEqual(jobs.map(job=>[job.prompt.save.inputs.filename_prefix.includes('first')?'first':job.prompt.save.inputs.filename_prefix.includes('second')?'second':'third',job.prompt.n.inputs.choice]), names.flatMap(name=>[[name,'b'],[name,'c']]));
    for (let i=0;i<6;i+=2) assert(requests[i+1].arrived<requests[i].replied,'next body arrives while prior response is held');
    const final = await get(B,'/api/features/variations/history/'+history.id);
    assert.deepEqual(final.submission,{sent:6,total:6}); assert.equal(final.outcome,'submitted');
    await c.poll(`!document.querySelector('.vz-submitting')`,10000);
    assert.deepEqual(errors,[]);
    const diff = await c.evaluate(`(async()=>{const load=src=>new Promise(resolve=>{const i=new Image;i.onload=()=>resolve(i);i.src=src});const [a,b]=await Promise.all([load('data:image/png;base64,${beforePng}'),load('data:image/png;base64,${duringPng}')]);const cv=document.createElement('canvas');cv.width=a.width;cv.height=a.height;const ctx=cv.getContext('2d');ctx.drawImage(a,0,0);const aa=ctx.getImageData(0,0,a.width,a.height).data;ctx.clearRect(0,0,a.width,a.height);ctx.drawImage(b,0,0);const bb=ctx.getImageData(0,0,a.width,a.height).data;let count=0,minX=a.width,minY=a.height,maxX=0,maxY=0;for(let y=0;y<a.height;y++)for(let x=0;x<a.width;x++){const k=(y*a.width+x)*4;if(aa[k]!==bb[k]||aa[k+1]!==bb[k+1]||aa[k+2]!==bb[k+2]){count++;minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y)}}return {changedPixels:count,bounds:{minX,minY,maxX,maxY}}})()`);
    const proof = {result,order,requests,before,during,centered,pending:pending.submission,final:final.submission,diff,pageErrors:errors};
    fs.writeFileSync(D+'/result.json',JSON.stringify(proof,null,2));
    console.log(JSON.stringify({result,arrivalOrder:jobs.map(job=>job.prompt.n.inputs.choice),pending:pending.submission,final:final.submission,diff,pageErrors:errors}));
  } finally { await c.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
