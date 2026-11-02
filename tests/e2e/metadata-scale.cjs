// tests/e2e/metadata-scale.cjs — the shown entry's metadata at real scale.
// Four sources at a real installation's scale (metadata-scale-sources.mjs:
// 21,659 outputs, ~3 KB graphs each, listings of 1–30 MB), the engine
// re-extracting thousands of them continuously (metadata version advancing),
// one source whose reads fail, new outputs arriving at the top, and the
// browser on a 6 MB/s link (a Wi-Fi LAN). In every scenario the selected top
// entry's own graph fields must render in Details within 2 s of selecting it.
const { CDP, sleep, collectPageErrors } = require('./cdp.cjs');
const fs = require('node:fs');
const { workPath } = require('./paths.cjs');
const ENGINE = process.env.E2E_ENGINE;
const SOURCES = JSON.parse(process.env.E2E_SCALE_SOURCES); // { name: "http://127.0.0.1:port" }
const DEADLINE_MS = 2000, THROUGHPUT = Number(process.env.E2E_SCALE_THROUGHPUT ?? 6_000_000);
const KZ = `(await import('/store/instance.js')).appStore`;
let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name} (${JSON.stringify(detail)})`);
  if (!ok) failures++;
}
const json = async (url, init) => { const response = await fetch(url, init); if (!response.ok) throw new Error(`${url}: ${response.status}`); return response.json(); };
const arrive = source => json(`${SOURCES[source]}/__test/arrive`, { method: 'POST' });

(async () => {
  const results = [];
  // Churn and a failing source are real preconditions, not assumptions.
  const listing = await json(`${ENGINE}/api/collections/comfyui/entries?inventory=1`);
  const before = await json(`${ENGINE}/api/collections/comfyui/meta?since=${listing.metaVersion ?? 1}`);
  await sleep(4000);
  const prefetch = await json(`${ENGINE}/api/prefetch`);
  const after = await json(`${ENGINE}/api/collections/comfyui/meta?since=${before.v}`);
  check('scale: four sources at real size', listing.entries.length >= 4572, { comfyui: listing.entries.length });
  check('scale: thousands pending re-extraction while the metadata version advances', prefetch.ingestPending >= 4000 && after.v > before.v,
    { ingestPending: prefetch.ingestPending, v: [before.v, after.v] });
  const page = await CDP.launch(9347, { windowSize: '1600,1100' });
  const errors = await collectPageErrors(page);
  await page.send('Network.enable');
  await page.send('Network.emulateNetworkConditions', { offline: false, latency: 3, downloadThroughput: THROUGHPUT, uploadThroughput: THROUGHPUT / 2 });
  const ready = source => `(async()=>{const s=${KZ};return s.state.host()===${JSON.stringify(source)}&&s.state.view().length>0&&!s.state.inventory?.loading})()`;
  const selectTop = `(async()=>{const s=${KZ},v=s.state.view(),f=s.state.images[v[0]].filename;
    s.handles.invoke('entry.select',{source:s.state.host(),file:f});return f})()`;
  const tokenOf = `(async()=>{const e=${KZ}.state.currentEntry()?.entry;return e?.meta?.nodes?.find(n=>n.type==='ScaleToken')?.inputs.token??null})()`;
  // act() brings the scenario to its shown top entry; the deadline runs from
  // that selection to the entry's own token rendered in Details.
  async function scenario(label, act, expectToken) {
    let shown, ms = null, token;
    try {
      shown = await act();
      const started = Date.now();
      const rendered = `(async()=>{const s=${KZ},e=s.state.currentEntry()?.entry;if(e?.filename!==${JSON.stringify(shown)})return false;
        const t=e.meta?.nodes?.find(n=>n.type==='ScaleToken')?.inputs.token;
        return !!t&&document.querySelector('#workspace .info-body')?.innerText.includes(t)})()`;
      await page.poll(rendered, 15000, 25).catch(() => null);
      ms = await page.evaluate(rendered) ? Date.now() - started : null;
      token = await page.evaluate(tokenOf);
    } catch (error) { token = String(error); }
    const details = await page.evaluate(`(async()=>document.querySelector('#workspace .info-body')?.innerText.slice(0,60))()`).catch(() => null);
    results.push({ label, shown, ms, token, details });
    check(`metadata scale: ${label} renders the shown entry's fields within ${DEADLINE_MS}ms`,
      ms !== null && ms <= DEADLINE_MS && (!expectToken || token === expectToken), { shown, ms, token, details });
  }
  try {
    // 1. Load: the newest output arrived just before; it is not ingested yet.
    let arrival = await arrive('comfyui');
    await scenario('initial load (top not yet ingested)', async () => {
      await page.goto(`${ENGINE}/#comfyui`);
      await page.poll(`(async()=>{try{${KZ}.actions.ui.setWorkspace('details');return true}catch{return false}})()`, 20000);
      await page.poll(ready('comfyui'), 90000);
      return page.evaluate(selectTop);
    }, arrival.token);
    // 2–5. Source switches: the failing source, a busy one with a new output, the small one, back.
    await scenario('switch to the source with failing reads', async () => {
      await page.evaluate(`(async()=>{window.__s=${KZ}.actions.hosts.select('ark');})()`);
      await page.poll(ready('ark'), 90000);
      return page.evaluate(selectTop);
    });
    arrival = await arrive('anton');
    await scenario('switch to a busy source (top not yet ingested)', async () => {
      await page.evaluate(`(async()=>{window.__s=${KZ}.actions.hosts.select('anton');})()`);
      await page.poll(ready('anton'), 90000);
      return page.evaluate(selectTop);
    }, arrival.token);
    await scenario('switch to the small source', async () => {
      await page.evaluate(`(async()=>{window.__s=${KZ}.actions.hosts.select('acropolis');})()`);
      await page.poll(ready('acropolis'), 90000);
      return page.evaluate(selectTop);
    });
    arrival = await arrive('comfyui');
    await scenario('switch back (top not yet ingested)', async () => {
      await page.evaluate(`(async()=>{window.__s=${KZ}.actions.hosts.select('comfyui');})()`);
      await page.poll(ready('comfyui'), 90000);
      return page.evaluate(selectTop);
    }, arrival.token);
    // 6. Back to the top after browsing deep into the feed.
    await scenario('scroll back to the top', async () => {
      await page.evaluate(`(async()=>{const s=${KZ},v=s.state.view(),i=v[300];s.actions.current.set('comfyui',s.state.images[i].filename);s.actions.feed.restoreToIndex(i)})()`);
      await page.poll(`(async()=>${KZ}.state.feedScrollEl().scrollTop>1000)()`, 10000);
      await page.evaluate(`(async()=>${KZ}.actions.feed.scrollTop())()`);
      await page.poll(`(async()=>${KZ}.state.feedScrollEl().scrollTop===0)()`, 10000);
      return page.evaluate(selectTop);
    });
    // 7. A new output while the source is shown: refresh, then select it.
    for (let n = 1; n <= 2; n++) {
      arrival = await arrive('comfyui');
      await scenario(`new output while shown #${n}`, async () => {
        await page.evaluate(`(async()=>{window.__r=${KZ}.actions.ui.refresh();})()`);
        await page.poll(`(async()=>${KZ}.state.images.some(e=>e.filename===${JSON.stringify(arrival.name)}))()`, 60000);
        const top = await page.evaluate(selectTop);
        if (top !== arrival.name) throw new Error(`top ${top} is not the new output ${arrival.name}`);
        return top;
      }, arrival.token);
    }
    const failing = await json(`${ENGINE}/api/prefetch`);
    check('scale: the failing source really failed reads during the run', !!failing.lastError?.ark, { ark: failing.lastError?.ark });
    check('metadata scale: no page errors', errors.length === 0, errors);
  } finally {
    fs.mkdirSync(workPath('tests/e2e/.shots'), { recursive: true });
    fs.writeFileSync(workPath('tests/e2e/.shots/metadata-scale.json'), JSON.stringify(results, null, 2));
    await page.shutdown();
  }
  console.log(failures ? `metadata-scale: ${failures} FAIL` : 'metadata-scale: all ok');
  process.exit(failures ? 1 : 0);
})().catch(error => { console.error(error); process.exit(1); });
