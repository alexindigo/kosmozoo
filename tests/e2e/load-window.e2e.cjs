// Plan §4 row 5: fresh, dimensionless 5,000-image acquisition, real input,
// 120 seconds. No timing thresholds are scaled with machine speed.
const { CDP, sleep, collectPageErrors } = require('./cdp.cjs');
const fs = require('node:fs');
const { workPath } = require('./paths.cjs');
const { performance } = require('node:perf_hooks');
const ENGINE = process.env.E2E_ENGINE;
const KZ = `(await import('/store/instance.js')).appStore`;
let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name} (${JSON.stringify(detail)})`);
  if (!ok) failures++;
}

(async () => {
  const page = await CDP.launch(9337, { windowSize: '1440,1000' });
  const errors = await collectPageErrors(page), requests = [], interactions = [];
  const active = new Map();
  let peakBackground = 0, firstBackground = null, initialWindow = null;
  const receive = page.ws.onmessage;
  page.ws.onmessage = event => {
    receive(event);
    const message = JSON.parse(event.data), p = message.params;
    if (message.method === 'Network.requestWillBeSent') {
      const url = new URL(p.request.url);
      const request = { id: p.requestId, url: p.request.url, time: p.timestamp,
        type: p.type, priority: p.request.initialPriority, method: p.request.method };
      if (url.pathname.endsWith('/want') && !initialWindow) {
        const body = JSON.parse(p.request.postData ?? '{}');
        if (body.priority === 'foreground') initialWindow = body.files;
      }
      if (p.type === 'Image' && url.pathname.endsWith('/bytes')) {
        request.name = decodeURIComponent(url.pathname.split('/').at(-2));
        request.background = url.searchParams.get('priority') === 'background';
        active.set(request.id, request);
        if (request.background && !firstBackground) {
          firstBackground = { time: p.timestamp, preceding: requests.filter(r => r.type === 'Image').map(r => r.name) };
        }
        peakBackground = Math.max(peakBackground, [...active.values()].filter(r => r.background).length);
      }
      requests.push(request);
    }
    if (message.method === 'Network.responseReceived') {
      const request = requests.findLast(r => r.id === p.requestId);
      if (request) request.etag = Object.entries(p.response.headers).find(([key]) => key.toLowerCase() === 'etag')?.[1];
    }
    if (message.method === 'Network.loadingFinished' || message.method === 'Network.loadingFailed') {
      const request = requests.findLast(r => r.id === p.requestId);
      if (request) { request.end = p.timestamp; request.failed = p.errorText; request.bytes = p.encodedDataLength; }
      active.delete(p.requestId);
    }
  };
  let evidence;
  try {
    await page.send('Network.enable', { maxPostDataSize: 1000000 });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__loadWindow = { longtasks: [], acceptance: null };
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) window.__loadWindow.longtasks.push({ start: entry.startTime, duration: entry.duration });
      }).observe({ type: 'longtask', buffered: true });
    ` });
    await page.goto(ENGINE + '/');
    await page.poll(`!!document.querySelector('.feed-empty')`, 15000);
    await page.evaluate(`(async () => {
      const store = ${KZ}, { api } = await import('/js/api.mjs');
      const { createRoot, createEffect } = await import('/vendor/solid/solid.mjs');
      const inventory = api.inventory;
      api.inventory = async (...args) => {
        const reply = await inventory(...args);
        window.__loadWindow.acceptance = { start: performance.now(), count: reply.entries.length,
          unknown: reply.entries.filter(e => !e.width || !e.height).length };
        return reply;
      };
      createRoot(dispose => {
        window.__loadWindow.dispose = dispose;
        createEffect(() => {
          const loading = store.state.inventory.loading, count = store.state.images.length;
          const acceptance = window.__loadWindow.acceptance;
          if (!loading && count && acceptance && !acceptance.end) acceptance.end = performance.now();
        });
      });
    })()`);
    await page.clickAt('#hostBtn');
    await page.evaluate(`(() => {
      for (const [id, value] of [['hostName', 'load'], ['hostAddr', ${JSON.stringify(process.env.E2E_FAKE.replace('http://', ''))}]]) {
        const el = document.getElementById(id); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    })()`);
    const start = performance.now();
    let focus = null;
    await page.clickAt('#hostAdd');
    for (let sample = 1; sample <= 59; sample++) {
      await sleep(Math.max(0, start + sample * 2000 - performance.now()));
      const disk = fs.statfsSync(workPath('tests'));
      if (disk.bavail * disk.bsize < 4000000000) throw new Error('disk below 4 GB evidence-preservation floor');
      const point = await page.evaluate(`(() => {
        const col = document.getElementById('candidatesCol'), rect = col.getBoundingClientRect();
        return { x: rect.left + 2, y: rect.top + rect.height / 2, top: col.scrollTop,
          delta: col.scrollTop + col.clientHeight + 500 < col.scrollHeight ? 300 : -300 };
      })()`);
      // End-to-end round trip includes dispatch, actual trusted scroll, and
      // a subsequent frame opportunity (not just receipt of the CDP ack).
      const inputStart = performance.now();
      await page.mouse('mouseWheel', point.x, point.y, { deltaY: point.delta, button: 'none' });
      const result = await page.evaluate(`new Promise(resolve => {
        const col = document.getElementById('candidatesCol'), start = performance.now();
        const frame = () => {
          if (col.scrollTop !== ${point.top}) requestAnimationFrame(() => resolve({ changed: true, top: col.scrollTop }));
          else if (performance.now() - start > 1000) resolve({ changed: false, top: col.scrollTop });
          else requestAnimationFrame(frame);
        }; requestAnimationFrame(frame);
      })`);
      interactions.push({ sample, elapsedMs: performance.now() - inputStart, ...result });
      if (sample === 5) {
        // The entry the user looks at is foreground demand: its metadata cannot
        // queue behind the library's background acquisition and publication.
        focus = await page.evaluate(`(async () => {
          const s = ${KZ}, image = s.state.view().map(i => s.state.images[i]).reverse().find(i => !(i.width && i.height));
          if (!image) return null;
          await s.handles.invoke('entry.select', { source: 'load', file: image.filename });
          const started = performance.now();
          while (performance.now() - started < 5000) {
            const now = s.state.images.find(i => i.id === image.id);
            if (now?.width && now?.height) return { file: image.filename, ms: performance.now() - started };
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          return { file: image.filename, ms: null };
        })()`);
      }
    }
    await sleep(Math.max(0, start + 120000 - performance.now()));
    const observed = await page.evaluate(`(() => {
      window.__loadWindow.dispose();
      return { longtasks: window.__loadWindow.longtasks, acceptance: window.__loadWindow.acceptance };
    })()`);
    const acceptance = observed.acceptance;
    // The acceptance task includes synchronous follow-through after the batch.
    const acceptanceTasks = observed.longtasks.filter(task => task.start <= acceptance?.end && task.start + task.duration >= acceptance?.start);
    const initialMs = Math.max(acceptance?.end - acceptance?.start || 0, ...acceptanceTasks.map(task => task.duration));
    const later = observed.longtasks.filter(task => task.start >= acceptance?.end);
    const latencies = interactions.map(item => item.elapsedMs).sort((a, b) => a - b);
    const p95 = latencies[Math.ceil(latencies.length * .95) - 1], max = latencies.at(-1);
    evidence = { durationMs: performance.now() - start, ...observed, initialMs, later, interactions,
      p95, max, initialWindow, firstBackground, peakBackground, requests, errors };
    check('load-window starts with 5,000 dimensionless bulk images', acceptance?.count === 5007 && acceptance.unknown >= 5000, acceptance);
    check('load-window initial acceptance <=100ms', acceptance?.end && initialMs <= 100, { initialMs });
    check('load-window no later long task >50ms during 120s', later.every(task => task.duration <= 50), later);
    check('load-window trusted scroll-to-frame every 2s: p95<=100ms / max<=200ms',
      interactions.length === 59 && interactions.every(item => item.changed) && p95 <= 100 && max <= 200,
      { count: interactions.length, changed: interactions.filter(item => item.changed).length, p95, max });
    check('load-window foreground window bytes precede background bytes', initialWindow?.length === 20 &&
      firstBackground && initialWindow.every(name => firstBackground.preceding.includes(name)), { initialWindow, firstBackground });
    check('load-window a dimensionless entry made current gets its dimensions within 5s during background loading',
      !!focus?.file && focus.ms !== null && focus.ms <= 5000, focus);
    check('load-window <=2 background image requests in flight', peakBackground > 0 && peakBackground <= 2, { peakBackground });
    const bulk = requests.filter(request => request.name?.startsWith('bulk-') && request.bytes > 900000);
    check('load-window uses generated unique pixel content, not tiny identical PNGs',
      bulk.length >= 2 && new Set(bulk.map(request => request.etag)).size >= 2,
      { images: bulk.length, distinctHashes: new Set(bulk.map(request => request.etag)).size });
    check('load-window has no uncaught exceptions', errors.length === 0, errors);
  } finally {
    fs.writeFileSync(workPath('tests/e2e/.shots/load-window.json'), JSON.stringify(evidence ?? { requests, interactions, errors }, null, 2));
    await page.close();
  }
  console.log(`\n${failures} FAIL`);
  process.exitCode = failures ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
