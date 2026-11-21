// Real Settings/header/confirmation path against disposable engine + Comfy fakes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const ENGINE = process.env.E2E_ENGINE;
const FAKE = process.env.E2E_FAKE;
const KZ = '(await import("/store/instance.js")).appStore';
const directory = process.env.E2E_EVIDENCE;
const source = 'acropolis';
const down = ['dd-down.png', 'nested/deep/dd-down.png'];
const kept = ['dd-star.png', 'dd-bookmark.png', 'dd-up.png', 'dd-none.png'];

async function http(base, route, method = 'GET', body) {
  const response = await fetch(base + route, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined });
  assert(response.ok, `${route}: ${response.status} ${await response.clone().text()}`);
  return response.json();
}

(async () => {
  fs.mkdirSync(directory, { recursive: true });
  await http(FAKE, '/__test/activity', 'POST', { assetsPlusDelete: true,
    publish: [...down, ...kept].map(name => ({ name, fixture: 'flux-basic.png' })) });
  const address = new URL(FAKE); address.hostname = '127.0.0.2';
  await http(ENGINE, '/api/collections', 'POST', { name: source, address: address.host });
  for (const name of [...down, kept[0], kept[1]]) await http(ENGINE, `/api/collections/${source}/entries/${encodeURIComponent(name)}/judgment`, 'PATCH', {
    vote: 'down', ...(name === kept[0] ? { favorite: true } : {}), ...(name === kept[1] ? { bookmark: true } : {}),
  });
  await http(ENGINE, `/api/collections/${source}/entries/${kept[2]}/judgment`, 'PATCH', { vote: 'up' });
  const page = await CDP.launch(9458, { windowSize: '1600,1100' });
  const errors = await collectPageErrors(page), records = [];
  const invoke = (id, args = {}) => page.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const capture = async (name, selector) => {
    await page.poll("[...document.querySelectorAll('.card:not(.card--probe) img[src]')].filter(img=>{const r=img.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight}).every(img=>img.complete&&img.naturalWidth>0)", 20000);
    await page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const screenshot = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(directory, name + '.png'), Buffer.from(screenshot.data, 'base64'));
    const geometry = await page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();
      return {bounds:r.toJSON(),contained:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,
        buttons:[...e.querySelectorAll('button')].map(b=>({text:b.textContent,disabled:b.disabled,bounds:b.getBoundingClientRect().toJSON()}))}})()`);
    assert(geometry.contained, JSON.stringify(geometry)); records.push({ name, geometry });
    for (const [region, target] of [['header', '#chrome'], ['surface', selector], ['rail', '#feedRail'], ['feed', '.card:not(.card--probe) .ctitle'], ['workspace', '#workspace'], ['status', '#statusCol']]) {
      const clip = await page.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(target)})?.getBoundingClientRect();if(!r)return null;
        const x=Math.max(0,r.left),y=Math.max(0,r.top),right=Math.min(innerWidth,r.right),bottom=Math.min(innerHeight,r.bottom);
        return right>x&&bottom>y?{x,y,width:right-x,height:bottom-y,scale:2}:null})()`);
      if (clip) {
        const crop = await page.send('Page.captureScreenshot', { format: 'png', clip });
        fs.writeFileSync(path.join(directory, name + '-' + region + '-review.png'), Buffer.from(crop.data, 'base64'));
      }
    }
  };
  const openMenu = async () => { await page.clickAt('#menuBtn'); await page.poll('!!document.querySelector("#deleteDownVoted")'); };
  const openDialog = async () => { await openMenu(); await page.clickAt('#deleteDownVoted'); await page.poll('!!document.querySelector("#confirmPanel .confirm-ok")'); };
  const listed = async () => (await http(ENGINE, `/api/collections/${source}/entries`)).map(entry => entry.name);
  const fakeNames = async () => JSON.stringify(await http(FAKE, '/internal/files/output'));
  try {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.goto(ENGINE + '/#fake');
    await page.poll(`(async()=>!!${KZ}.state.hosts.acropolis&&!!document.querySelector('.card'))()`);
    await openMenu();
    assert.equal(await page.evaluate('document.querySelector("#deleteDownVoted").textContent'), 'Delete down-voted images from fake source');
    await page.clickAt('#menuBtn'); await page.clickAt('#hostBtn');
    await page.clickAt('#hostList [data-source="acropolis"] .hname');
    await page.poll(`(async()=>${KZ}.state.host()==='acropolis'&&${KZ}.state.images.some(i=>i.filename==='dd-star.png'))()`);
    await invoke('preference.downvoteHides', { value: false });
    await openMenu();
    assert.equal(await page.evaluate('document.querySelector("#deleteDownVoted").textContent'), 'Delete down-voted images from acropolis source');
    await capture('delete-down-voted-settings', '#menu');
    // Settings search uses the row's actual current-source wording.
    await page.clickAt('#menuSearch'); await page.send('Input.insertText', { text: 'acropolis' });
    await page.poll('document.querySelector("#menuRows").children.length===1');
    assert(await page.evaluate('!!document.querySelector("#deleteDownVoted")'));
    await page.evaluate('document.querySelector("#menuSearch").select()'); await page.keyTrusted('Backspace', { vk: 8 });
    const before = await listed(), fakeBefore = await fakeNames();
    await page.clickAt('#deleteDownVoted'); await page.poll('!!document.querySelector("#confirmPanel .confirm-ok")');
    assert.equal(await page.evaluate('document.querySelector("#confirmPanel .confirm-body p").textContent'), 'Delete 2 down-voted images from acropolis?');
    assert((await page.evaluate('document.querySelector("#confirmPanel").textContent')).includes("They go to ComfyUI's trash."));
    assert((await page.evaluate('document.querySelector("#confirmPanel").textContent')).includes('Starred and bookmarked images are kept.'));
    await capture('delete-down-voted', '#confirmPanel');
    await page.clickAt('#confirmPanel .confirm-cancel'); await page.poll('!document.querySelector("#confirmPanel")');
    assert.deepEqual(await listed(), before); assert.equal(await fakeNames(), fakeBefore);
    console.log('PASS live header source label/search, real preview count/capability and Cancel has zero effects');

    // A folder/filter hiding every candidate must not narrow source-wide work.
    await invoke('source.folder', { folder: 'nested' }); await invoke('feed.filter', { value: 'no-matching-file' });
    await openDialog();
    assert.equal(await page.evaluate('document.querySelector("#confirmPanel .confirm-body p").textContent'), 'Delete 2 down-voted images from acropolis?');
    await page.clickAt('#confirmPanel .confirm-cancel'); await page.poll('!document.querySelector("#confirmPanel")');
    await invoke('feed.filter.clear'); await invoke('source.folder', { folder: '' });
    for (const name of [...down, kept[0]]) await invoke('selection.set', { id: `${source}:${name}`, value: true });
    await openDialog(); await page.clickAt('#confirmPanel .confirm-ok'); await page.poll('!document.querySelector("#confirmPanel")');
    await page.poll(`(async()=>!${KZ}.state.images.some(i=>${JSON.stringify(down)}.includes(i.filename)))()`);
    const after = await listed(), fakeAfter = await fakeNames();
    for (const name of down) { assert(!after.includes(name)); assert(!fakeAfter.includes(name)); }
    for (const name of kept) { assert(after.includes(name)); assert(fakeAfter.includes(name)); }
    assert.deepEqual(before.filter(name => !after.includes(name)).sort(), [...down].sort());
    assert.equal(await page.evaluate(`(async()=>!!${KZ}.state.selected['acropolis:dd-star.png']&&Object.keys(${KZ}.state.selected).length===1)()`), true);
    await page.poll('document.body.textContent.includes("2 deleted, 0 skipped, 0 failed")');
    await invoke('source.reload');
    assert.equal(await page.evaluate(`(async()=>${KZ}.state.images.some(i=>i.filename==='dd-star.png'))()`), true);
    console.log('PASS exact source-wide deletions reach fake backend and feed; starred/bookmarked/up/none remain; selection and reload agree');

    await openMenu(); await page.clickAt('#deleteDownVoted');
    await page.poll('document.querySelector("#confirmPanel .confirm-body").textContent.includes("There are no down-voted images to delete")');
    assert.equal(await page.evaluate('!!document.querySelector("#confirmPanel .confirm-ok")'), false);
    await capture('delete-down-voted-empty', '#confirmPanel');
    await page.clickAt('#confirmPanel .confirm-cancel'); await page.poll('!document.querySelector("#confirmPanel")');
    console.log('PASS zero matches omit Delete');

    const race = ['dd-race.png', 'dd-protected-after-preview.png'];
    await http(FAKE, '/__test/activity', 'POST', { publish: race.map(name => ({ name, fixture: 'flux-basic.png' })) });
    for (const name of race) await http(ENGINE, `/api/collections/${source}/entries/${name}/judgment`, 'PATCH', { vote: 'down' });
    await invoke('source.reload'); await openDialog();
    await http(ENGINE, `/api/collections/${source}/entries/${race[1]}/judgment`, 'PATCH', { bookmark: true });
    await page.evaluate(`(()=>{const original=window.fetch;window.__ddRestore=()=>window.fetch=original;
      window.fetch=(url,options)=>String(url).includes('/delete-down-voted')&&JSON.parse(options.body).names
        ?new Promise((resolve,reject)=>window.__ddRelease=()=>original(url,options).then(resolve,reject)):original(url,options)})()`);
    await page.clickAt('#confirmPanel .confirm-ok'); await page.poll('!!window.__ddRelease');
    assert.equal(await page.evaluate('document.querySelectorAll("#confirmPanel button").length'), 0);
    await page.keyTrusted('Escape', { vk: 27 });
    assert(await page.evaluate('!!document.querySelector("#confirmPanel .confirm-actions [role=status]")'));
    await capture('delete-down-voted-pending', '#confirmPanel');
    await page.evaluate('__ddRelease();__ddRestore()'); await page.poll('!document.querySelector("#confirmPanel")');
    await page.poll('document.body.textContent.includes("1 deleted, 1 skipped, 0 failed")');
    assert(!(await listed()).includes(race[0])); assert((await listed()).includes(race[1]));
    console.log('PASS pending actions replaced by status; Escape cannot replay/cancel effects; post-preview protection is skipped');

    await page.evaluate(`(()=>{const original=window.fetch;window.__ddRestore=()=>window.fetch=original;
      window.fetch=(url,options)=>String(url).includes('/delete-down-voted')?Promise.resolve(new Response(JSON.stringify({error:'Controlled preview failure'}),{status:503})):original(url,options)})()`);
    await openMenu(); await page.clickAt('#deleteDownVoted'); await page.poll('!!document.querySelector("#confirmPanel .confirm-error")');
    assert(!await page.evaluate('!!document.querySelector("#confirmPanel .confirm-ok")'));
    assert.equal(await page.evaluate('document.querySelector("#confirmPanel .confirm-error").textContent'), 'Controlled preview failure');
    assert(await page.evaluate(`(()=>{const e=document.querySelector('#confirmPanel .confirm-error'),p=document.querySelector('#confirmPanel').getBoundingClientRect(),range=document.createRange();
      range.selectNodeContents(e);return [...range.getClientRects()].every(r=>r.left>=p.left&&r.right<=p.right)})()`));
    await capture('delete-down-voted-error', '#confirmPanel');
    await page.clickAt('#confirmPanel .confirm-cancel'); await page.evaluate('__ddRestore()');
    await page.poll('!document.querySelector("#confirmPanel")');

    // Exercise the retained per-card confirmation branch as well.
    await invoke('image.delete.request', { id: `${source}:${race[1]}` });
    await page.poll('!!document.querySelector("#confirmPanel .confirm-ok")');
    await page.clickAt('#confirmPanel .confirm-cancel'); await page.poll('!document.querySelector("#confirmPanel")');
    assert((await listed()).includes(race[1]));
    await invoke('image.delete.request', { id: `${source}:${race[1]}` });
    await page.poll('!!document.querySelector("#confirmPanel .confirm-ok")'); await page.clickAt('#confirmPanel .confirm-ok');
    await page.poll('!document.querySelector("#confirmPanel")');
    assert(!(await listed()).includes(race[1])); assert(!(await fakeNames()).includes(race[1]));
    assert.deepEqual(errors, []); console.log('PASS preview errors omit Delete; existing single-entry Cancel/Delete branch; zero page errors');
  } finally {
    fs.writeFileSync(path.join(directory, 'delete-down-voted.json'), JSON.stringify({ records, errors }, null, 2));
    await page.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
