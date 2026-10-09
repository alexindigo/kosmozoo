const assert = require('node:assert/strict');
const { CDP, sleep, collectPageErrors } = require('./cdp.cjs');

async function observeSources(page) {
  const requests = [], frames = [], responses = [];
  const original = page.ws.onmessage;
  page.ws.onmessage = event => {
    original(event);
    const message = JSON.parse(event.data), p = message.params;
    if (message.method === 'Network.requestWillBeSent') requests.push({ id:p.requestId, at:p.timestamp, url:p.request.url, method:p.request.method, type:p.type });
    if (message.method === 'Network.responseReceived') responses.push({ id:p.requestId, status:p.response.status, mime:p.response.mimeType });
    if (message.method === 'Network.eventSourceMessageReceived') frames.push({ id:p.requestId, at:p.timestamp, name:p.eventName, eventId:p.eventId, data:p.data });
  };
  await page.send('Network.enable');
  const streams = () => requests.filter(r => new URL(r.url).pathname === '/api/events');
  const activity = () => requests.filter(r => new URL(r.url).pathname.endsWith('/activity'));
  const validate = async () => {
    const { validateSourceSnapshot } = await import('/work/client/js/source-events.mjs');
    for (const frame of frames) {
      assert.equal(frame.name,'sources'); const snapshot=validateSourceSnapshot(JSON.parse(frame.data));
      assert.equal(frame.eventId,`${snapshot.epoch}:${snapshot.revision}`);
    }
  };
  const save = name => {
    const fs=require('node:fs');fs.mkdirSync('/work/tests/e2e/.shots',{recursive:true});
    fs.writeFileSync(`/work/tests/e2e/.shots/${name}.json`,JSON.stringify({requests,frames,responses,
      streams:streams().length,activityGets:activity().length},null,2));
  };
  return { requests, frames, responses, streams, activity, validate, save };
}

async function healthyTraffic({ page, traffic, ENGINE, KZ, check }) {
  await page.poll(`(async()=>${KZ}.state.sourceDelivery()==='ready')()`,10000);
  const start=Date.now(); await sleep(120000);
  assert.equal(traffic.streams().length,1); assert.equal(traffic.activity().length,0);
  await traffic.validate(); assert(traffic.frames.length>=1);
  traffic.save('source-traffic-idle');
  assert(traffic.responses.some(r=>r.id===traffic.streams()[0].id&&r.status===200&&r.mime==='text/event-stream'));
  check('native source traffic: one healthy stream, zero activity GETs from bootstrap through120s idle',true,
    JSON.stringify({idleMs:Date.now()-start,connections:traffic.streams().length,activityGets:traffic.activity().length,frames:traffic.frames.length}));
  await page.evaluate(`(async()=>{const s=${KZ}; await s.actions.hosts.select('fixture-dir');await s.actions.hosts.select('fake');
    await s.actions.hosts.patch('fake',{pinned:true});s.actions.folders.select('unavailable-stream-scope');s.actions.folders.select('');
    await s.actions.hosts.patch('fake',{pinned:false});})()`);
  assert.equal(traffic.streams().length,1); assert.equal(traffic.activity().length,0);

  // A second page target shares this Chromium process and its per-origin pool.
  const { targetId }=await page.send('Target.createTarget',{url:'about:blank'});
  const port=new URL(page.wsUrl).port;
  const targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target=targets.find(t=>t.id===targetId); assert(target);
  const other=new CDP(page.proc,target.webSocketDebuggerUrl);
  await other.connect(); const errors=await collectPageErrors(other), second=await observeSources(other);
  try {
    await other.goto(ENGINE+'/#fake#flux-basic.png');
    await other.poll(`document.querySelector('.card[data-name="flux-basic.png"] img')?.naturalWidth>0`,20000);
    await other.poll(`(async()=>${KZ}.state.sourceDelivery()==='ready')()`);
    assert.equal(second.streams().length,1); assert.equal(second.activity().length,0);
    const responsive=await page.evaluate(`(async()=>{const [api,bytes]=await Promise.all([fetch('/api/settings/core.ui'),
      fetch('/api/collections/fake/entries/flux-basic.png/bytes')]);return{api:api.status,bytes:bytes.status,length:(await bytes.arrayBuffer()).byteLength};})()`);
    assert.equal(responsive.api,200); assert.equal(responsive.bytes,200); assert(responsive.length>100);
    await page.evaluate(`(async()=>await ${KZ}.actions.hosts.patch('fake',{pinned:true}))()`);
    await other.poll(`(async()=>${KZ}.state.hosts.fake.pinned)()`);
    const source=await page.evaluate(`(async()=>${KZ}.state.hosts.fake.address)()`);
    await page.evaluate(`(async()=>await ${KZ}.actions.hosts.add('sse-alias',${JSON.stringify(source)}))()`);
    await other.poll(`(async()=>!!${KZ}.state.hosts['sse-alias'])()`);
    const old=await other.evaluate(`(async()=>${KZ}.state.hosts['sse-alias'].incarnation)()`);
    await page.evaluate(`(async()=>await ${KZ}.actions.hosts.remove('sse-alias'))()`);
    await other.poll(`(async()=>!${KZ}.state.hosts['sse-alias'])()`);
    await page.evaluate(`(async()=>await ${KZ}.actions.hosts.add('sse-alias',${JSON.stringify(source)}))()`);
    await other.poll(`(async()=>${KZ}.state.hosts['sse-alias']?.incarnation&&${KZ}.state.hosts['sse-alias'].incarnation!==${JSON.stringify(old)})()`);
    assert.equal(await other.evaluate(`(async()=>${KZ}.state.host())()`),'fake','inactive additions never select themselves');
    await page.evaluate(`(async()=>{await ${KZ}.actions.hosts.remove('sse-alias');await ${KZ}.actions.hosts.patch('fake',{pinned:false});})()`);
    await other.poll(`(async()=>!${KZ}.state.hosts.fake.pinned&&!${KZ}.state.hosts['sse-alias'])()`);
    assert.equal(traffic.streams().length,1); assert.equal(second.streams().length,1);
    assert.equal(traffic.activity().length+second.activity().length,0);
    check('native source registry: two tabs receive flags/membership/reincarnation without polling or reconnecting, API/bytes responsive',true,JSON.stringify(responsive));

    // Characterize the actual HTTP1 pool boundary with six native streams.
    await other.evaluate(`window.__poolReady=0;window.__poolExtra=Array.from({length:4},()=>{const s=new EventSource('/api/events');
      let first=true;s.addEventListener('sources',()=>{if(first){first=false;window.__poolReady++;}});return s;});`);
    await other.poll('window.__poolReady===4',10000);
    const boundary=await other.evaluate(`(async()=>{const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),1000);
      try{return{status:(await fetch('/api/settings/core.ui?pool-boundary=1',{signal:abort.signal,cache:'no-store'})).status};}
      catch(error){return{error:error.name};}finally{clearTimeout(timer);}})()`);
    assert.equal(boundary.error,'AbortError','six live HTTP1 streams exhaust this Chromium per-origin pool');
    await other.evaluate('window.__poolExtra[0].close()');
    assert.equal(await other.evaluate(`(async()=>(await fetch('/api/settings/core.ui?pool-released=1',{cache:'no-store'})).status)()`),200);
    await other.evaluate('window.__poolExtra.forEach(s=>s.close());delete window.__poolExtra;delete window.__poolReady');
    check('native HTTP1 boundary: six streams occupy the shared pool; releasing one restores ordinary HTTP',true,JSON.stringify(boundary));

    const cacheToken=await other.evaluate(`window.__sourceCacheToken=crypto.randomUUID();window.__sourceCacheShows=[];
      window.addEventListener('pageshow',event=>window.__sourceCacheShows.push(event.persisted));window.__sourceCacheToken`);
    await other.goto('about:blank');
    const history=await other.send('Page.getNavigationHistory');
    await other.send('Page.navigateToHistoryEntry',{entryId:history.entries[history.currentIndex-1].id});
    await other.poll(`(async()=>location.origin===${JSON.stringify(ENGINE)}&&${KZ}.state.sourceDelivery()==='ready')()`,15000);
    const cache=await other.evaluate(`({retained:window.__sourceCacheToken===${JSON.stringify(cacheToken)},shows:window.__sourceCacheShows??[]})`);
    assert(cache.retained&&cache.shows.includes(true),'real Back/Forward restores the same bfcache Store and resumes delivery');
    assert.equal(second.streams().length,6,'one initial app stream, four pool probes and one bfcache resume');
    assert.equal(second.activity().length,0);
    check('native bfcache: actual away/Back retains the same Store and resumes one owned stream',true,JSON.stringify(cache));
    await second.validate(); assert.deepEqual(errors,[]);
  } finally {
    await page.send('Target.closeTarget',{targetId}); other.ws.close();
  }
  await page.evaluate(`(async()=>${KZ}.actions.hosts.select('fake'))()`);
}

module.exports={observeSources,healthyTraffic};
