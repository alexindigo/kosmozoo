// Dedicated cached-stream/static-byte probe. It never boots the production SPA.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {createHash}=require('node:crypto');
const {CDP,sleep,collectPageErrors}=require('./cdp.cjs');
const paths=['/main.js','/store/app-store.js','/store/source-registry.js','/store/source-freshness.js','/js/api.mjs','/js/source-events.mjs'];

(async()=>{
  assert.equal(process.env.KOSMOZOO_TEST_VM_UUID,'838fd0e0-e75a-4b21-9ada-8dad6562b151','named-VM route attestation is required');
  const ENGINE=new URL(process.env.E2E_ENGINE).origin;
  const manifest=JSON.parse(fs.readFileSync(process.env.STATIC_MANIFEST,'utf8'));
  assert.equal(manifest.version,1);assert.deepEqual(Object.keys(manifest.files).sort(),paths.slice().sort());
  const requests=[],frames=[],violations=[],staticHashes={};
  const page=await CDP.launch(9357);const pageErrors=await collectPageErrors(page);
  let requestHandler;
  try{
    const original=page.ws.onmessage;
    requestHandler=async p=>{
      const url=new URL(p.request.url);
      if(p.request.method!=='GET'||url.origin!==ENGINE){violations.push(p.request);await page.send('Fetch.failRequest',{requestId:p.requestId,errorReason:'BlockedByClient'});return;}
      if(url.pathname==='/'&&!url.search){
        await page.send('Fetch.fulfillRequest',{requestId:p.requestId,responseCode:200,
          responseHeaders:[{name:'Content-Type',value:'text/html'}],body:Buffer.from('<!doctype html><title>Read-only source stream probe</title><link rel="icon" href="data:,">').toString('base64')});return;
      }
      if(url.pathname!=='/api/events'||url.search){violations.push(p.request);await page.send('Fetch.failRequest',{requestId:p.requestId,errorReason:'BlockedByClient'});return;}
      await page.send('Fetch.continueRequest',{requestId:p.requestId});
    };
    page.ws.onmessage=event=>{
      original(event);const message=JSON.parse(event.data),p=message.params;
      if(message.method==='Fetch.requestPaused')requestHandler(p).catch(error=>violations.push(String(error)));
      if(message.method==='Network.requestWillBeSent')requests.push({url:p.request.url,method:p.request.method,type:p.type,at:p.timestamp});
      if(message.method==='Network.eventSourceMessageReceived')frames.push(p);
    };
    await page.send('Network.enable');await page.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
    await page.goto(ENGINE+'/');
    await page.evaluate(`window.__probeFrames=[];window.__probeError=false;window.__probe=new EventSource('/api/events');
      window.__probe.addEventListener('sources',event=>window.__probeFrames.push({data:event.data,id:event.lastEventId}));
      window.__probe.onerror=()=>{window.__probeError=true;window.__probe.close();};`);
    await page.poll('window.__probeFrames.length>0&&!window.__probeError',10000);
    // Node requests use this exact six-static-module allow-list; never APIs.
    for(const path of paths){
      const response=await fetch(ENGINE+path,{method:'GET',redirect:'error'});assert.equal(response.status,200);
      const hash=createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
      assert.equal(hash,manifest.files[path],`deployed static mismatch: ${path}`);staticHashes[path]=hash;
    }
    await sleep(120000);
    assert.equal(await page.evaluate('window.__probeError'),false);
    const {validateSourceSnapshot}=await import('/work/client/js/source-events.mjs');
    for(const event of frames){assert.equal(event.eventName,'sources');const frame=validateSourceSnapshot(JSON.parse(event.data));assert.equal(event.eventId,`${frame.epoch}:${frame.revision}`);}
    const streams=requests.filter(r=>new URL(r.url).pathname==='/api/events');assert.equal(streams.length,1);assert(frames.length>0);
    assert.equal(requests.filter(r=>new URL(r.url).pathname.endsWith('/activity')).length,0);assert.deepEqual(violations,[]);assert.deepEqual(pageErrors,[]);
    await page.evaluate('window.__probe.close()');
    fs.writeFileSync(process.env.READONLY_RESULT,JSON.stringify({origin:ENGINE,requests,frames,staticHashes,violations,
      proof:'matching selected static modules and cached native stream; full SPA/generation not exercised'},null,2));
    console.log('CACHED DEPLOYED SOURCE STREAM/STATIC PASS',JSON.stringify({connections:streams.length,frames:frames.length,modules:paths.length}));
  }finally{try{await page.evaluate('window.__probe?.close()');}finally{await page.close();}}
})().catch(error=>{console.error(error);process.exitCode=1;});
