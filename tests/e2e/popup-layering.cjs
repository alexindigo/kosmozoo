// Page popups own paint AND native input above content-local chrome.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { workPath } = require('./paths.cjs');

const KZ = '(await import("/store/instance.js")).appStore';
const prefix = 'popup-layering-';
const names = ['a', 'b', 'c'].map(n => `${prefix}${n}.png`);
const card = `.card[data-name="${names[0]}"]`;
const frame = 'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))';
const output = () => process.env.E2E_LAYER_OUTPUT || workPath('tests/e2e/.shots/popup-layering');

async function capture(page, name) {
  await page.evaluate(frame);
  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(output(), `${name}.png`), Buffer.from(shot.data, 'base64'));
}

const geometry = `(async()=>{
  const s=${KZ}, r=e=>e.getBoundingClientRect().toJSON();
  return {boxes:[...document.querySelectorAll('#chrome,main,#candidatesCol,#workspace,.card')].map(e=>({
    key:e.id||e.dataset.name,rect:r(e)})),scroll:s.state.feedScrollEl().scrollTop,
    strides:s.state.feedVirtualizer().getVirtualItems().map(i=>({key:i.key,size:i.size}))};
})()`;
function sameGeometry(a, b) {
  return a.scroll === b.scroll && JSON.stringify(a.strides) === JSON.stringify(b.strides) &&
    a.boxes.length === b.boxes.length && a.boxes.every((box, i) => box.key === b.boxes[i].key &&
      ['x', 'y', 'width', 'height'].every(k => Math.abs(box.rect[k] - b.boxes[i].rect[k]) <= .5));
}

async function intersections(page, popup, chrome) {
  return page.evaluate(`(()=>{
    const p=document.querySelector(${JSON.stringify(popup)}),r=p.getBoundingClientRect();
    const label=e=>e.tagName.toLowerCase()+(e.id?'#'+e.id:'')+(typeof e.className==='string'&&e.className?'.'+e.className.trim().split(/\\s+/).join('.'): '');
    return [...document.querySelectorAll(${JSON.stringify(chrome)})].flatMap(e=>{
      const s=e.getBoundingClientRect(),left=Math.max(r.left,s.left),right=Math.min(r.right,s.right),
        top=Math.max(r.top,s.top,0),bottom=Math.min(r.bottom,s.bottom,innerHeight);
      if(left>=right||top>=bottom)return [];
      return [.25,.5,.75].map(f=>{const x=left+(right-left)*f,y=top+(bottom-top)/2;
        return {chrome:e.id||e.className,x,y,popup:r.toJSON(),rect:s.toJSON(),
          owns:p.contains(document.elementFromPoint(x,y)),paint:document.elementsFromPoint(x,y).map(label)};});
    });
  })()`);
}

module.exports = async ({ page, ENGINE, FAKE, check }) => {
  fs.mkdirSync(output(), { recursive: true });
  const records = [];
  const invoke = (id, args = {}) => page.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const control = async body => {
    const response = await fetch(FAKE + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert(response.ok, `fixture control: ${response.status}`);
  };
  const outcome = async expression => {
    try { await page.poll(expression, 1500); return true; }
    catch (error) { if (!error.message.startsWith('poll timeout')) throw error; return false; }
  };
  const click = async point => {
    await page.mouse('mousePressed', point.x, point.y, { clickCount: 1, buttons: 1 });
    await page.mouse('mouseReleased', point.x, point.y, { clickCount: 1, buttons: 0 });
    await page.evaluate(frame);
  };
  const open = async (button, panel) => {
    await page.clickAt(button);
    await page.poll(`(()=>{const p=document.querySelector('${panel}');return p&&!p.hidden})()`);
  };
  const outside = async () => {
    const p = await page.evaluate(`(()=>{const r=document.querySelector('#feedRail').getBoundingClientRect();return{x:r.left+2,y:r.top+100}})()`);
    await click(p);
  };
  const audit = async (record, key, popup, chrome) => {
    const points = await intersections(page, popup, chrome);
    record[key] = points;
    check(`${record.width}: ${key} popup owns every measured intersection`, points.length > 0 && points.every(p => p.owns), JSON.stringify(points));
  };
  let saved;
  try {
    await page.poll(`(async()=>!!${KZ}.state.hosts.another)()`);
    saved = await page.evaluate(`(async()=>{const s=${KZ};return{width:s.state.anchorPaneWidth(),split:s.ui.info.split,layout:s.state.infoLayout(),workspace:s.state.workspace(),pin:s.state.hosts.another.pinned}})()`);
    const form = new FormData();
    form.append('image', new Blob([fs.readFileSync(workPath('tests/fixtures/media/square.png'))]), `${prefix}input.png`);
    const upload = await fetch(FAKE + '/api/upload/image', { method: 'POST', body: form });
    assert(upload.ok || upload.status === 409, `fixture input: ${upload.status}`);
    const graph = { '1': { class_type: 'LoadImage', inputs: { image: `${prefix}input.png` } },
      '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: prefix } } };
    await control({ publish: names.map((name, i) => ({ name, fixture: 'media/square.png', graph, mtime: 2100010000 - i })) });
    for (const width of [1400, 720]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 600, deviceScaleFactor: 1, mobile: false });
      // Existing intents prepare fixture scope; interactions under test use native input.
      await invoke('source.select', { id: 'fake' });
      await invoke('workspace.select', { space: 'details' });
      await invoke('metadata.layout', { layout: 'split' });
      await page.evaluate(`(async()=>{const s=${KZ};s.actions.anchors.setPaneWidth(300);s.actions.ui.info.split.set(.5)})()`);
      await invoke('feed.filter', { value: prefix });
      await invoke('source.refresh');
      await invoke('entry.select', { source: 'fake', file: names[0] });
      await invoke('feed.revealEntry', { id: `fake:${names[0]}` });
      await page.poll(`document.querySelector('${card} img')?.naturalWidth>0&&!!document.querySelector('.separator')`, 30000);
      await page.poll(`(async()=>${KZ}.state.feedActivity()==='settled')()`);
      const record = { width };
      records.push(record);
      record.initial = await page.evaluate(`(()=>{const c=document.querySelector('${card}'),r=e=>e.getBoundingClientRect().toJSON();return{card:r(c),foot:r(c.querySelector('.card-foot')),viewport:r(document.querySelector('#candidatesCol'))}})()`);
      if (width === 1400) check('desktop genuine sticky foot initially pins below a tall card',
        record.initial.card.bottom > record.initial.viewport.bottom && Math.abs(record.initial.foot.bottom - record.initial.viewport.bottom) <= 1, JSON.stringify(record.initial));
      const wheel = await page.evaluate(`(()=>{const r=document.querySelector('${card}').getBoundingClientRect(),v=document.querySelector('#candidatesCol').getBoundingClientRect();return{x:v.left+2,y:v.top+20,delta:r.bottom-178}})()`);
      await page.mouse('mouseWheel', wheel.x, wheel.y, { deltaY: wheel.delta, deltaX: 0 });
      await page.poll(`document.querySelector('${card} .card-foot').getBoundingClientRect().bottom<200`);
      await page.poll(`(async()=>${KZ}.state.feedActivity()==='settled')()`);
      record.closed = await page.evaluate(geometry);
      await open('#hostBtn', '#hostDrop');
      await audit(record, 'source-foot', '#hostDrop', `${card} .card-foot`);
      record.open = await page.evaluate(geometry);
      check(`${width}: source popup preserves toolbar/feed/card geometry and virtual strides`, sameGeometry(record.closed, record.open));
      await capture(page, `${width}-source-foot`);
      // Focus and a real source action must not fall through to feedback or select its row.
      await page.clickAt('#hostName');
      check(`${width}: add-source field receives native focus`, await outcome(`document.activeElement.id==='hostName'`));
      await page.keyTrusted('Tab', { vk: 9 });
      check(`${width}: source input native Tab reaches address field`, await page.evaluate(`document.activeElement.id==='hostAddr'`));
      const pin = '#hostDrop [data-source="another"] .pin';
      await page.clickAt(pin);
      const changed = await outcome(`(async()=>${KZ}.state.hosts.another.pinned===${!saved.pin})()`);
      check(`${width}: source action reaches its button without selecting/closing`, changed && await page.evaluate(`(async()=>${KZ}.state.host()==='fake'&&!document.querySelector('#hostDrop').hidden)()`));
      if (changed) {
        await page.poll(`(async()=>!${KZ}.state.sourceSaving.another)()`);
        await page.clickAt(pin);
        await page.poll(`(async()=>${KZ}.state.hosts.another.pinned===${saved.pin}&&!${KZ}.state.sourceSaving.another)()`);
      }
      if (await page.evaluate(`document.querySelector('#hostDrop').hidden`)) await open('#hostBtn', '#hostDrop');
      const target = await page.evaluate(`(()=>{const r=document.querySelector('#hostDrop [data-source="another"] .hname').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
      await click(target);
      record.sourceActivation = await page.evaluate(`(async()=>({host:${KZ}.state.host(),focus:document.activeElement.tagName}))()`);
      check(`${width}: obscured source-row native activation selects another, never feedback`, await outcome(`(async()=>${KZ}.state.host()==='another')()`), JSON.stringify(record.sourceActivation));
      await invoke('source.select', { id: 'fake' });
      await invoke('feed.filter', { value: prefix });
      await invoke('feed.revealEntry', { id: `fake:${names[0]}` });
      await page.poll(`!!document.querySelector('${card} .selcb')`);
      await page.clickAt(`${card} .selcb`);
      await page.poll(`!!document.querySelector('#bulkBar')`);
      await open('#hostBtn', '#hostDrop');
      await audit(record, 'source-selection', '#hostDrop', '#bulkBar');
      await outside();
      check(`${width}: source outside dismissal remains native`, await page.evaluate(`document.querySelector('#hostDrop').hidden`));
      await open('#menuBtn', '#menu');
      await audit(record, 'options-selection', '#menu', '#bulkBar');
      await page.clickAt('#menuSearch');
      check(`${width}: Options search above selection receives native focus`, await outcome(`document.activeElement.id==='menuSearch'`));
      if (await page.evaluate(`!!document.querySelector('#menu')`)) await outside();
      await page.clickAt('#bulkBar .clear-selection');
      await page.poll(`!document.querySelector('#bulkBar')`);
      // Use the real workspace controls, at supported widths, to expose their intersections.
      const divider = await page.evaluate(`(()=>{const r=document.querySelector('#divider').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+120}})()`);
      await page.drag(divider.x, divider.y, divider.x + 120, divider.y);
      await page.poll(`document.querySelector('#workspace').getBoundingClientRect().width<=221`);
      await open('#menuBtn', '#menu');
      await audit(record, 'options-workspace', '#menu', '#divider,.separator');
      await capture(page, `${width}-options-workspace`);
      await outside();
      check(`${width}: Options outside dismissal remains native`, await page.evaluate(`!document.querySelector('#menu')`));
      if (width === 720) {
        await open('#hostBtn', '#hostDrop');
        await audit(record, 'source-workspace', '#hostDrop', '#divider,.separator');
        await outside();
      }
      const sep = await page.evaluate(`(()=>{const r=document.querySelector('.separator').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+120,split:document.querySelector('.info-source-images').getBoundingClientRect().width}})()`);
      // At minimum pane width the text floor caps image growth; shrink instead.
      await page.drag(sep.x, sep.y, sep.x - 40, sep.y);
      check(`${width}: Details separator remains draggable after popup closes`, await outcome(`Math.abs(document.querySelector('.info-source-images').getBoundingClientRect().width-${sep.split})>2`));
      // Filter is portaled already: focus, selection/divider hit order and dismissal remain intact.
      await page.clickAt(`${card} .selcb`);
      await page.poll(`!!document.querySelector('#bulkBar')`);
      await open('#filterBtn', '#filterMenu');
      check(`${width}: filter filename receives focus`, await outcome(`document.activeElement.id==='filter'`));
      await audit(record, 'filter-selection', '#filterMenu', '#bulkBar');
      if (width === 720) await audit(record, 'filter-divider', '#filterMenu', '#divider');
      await page.keyTrusted('Escape', { vk: 27 });
      check(`${width}: filter Escape closes and restores trigger`, await page.evaluate(`document.querySelector('#filterMenu').hidden&&document.activeElement.id==='filterBtn'`));
      await open('#filterBtn', '#filterMenu');
      await outside();
      check(`${width}: filter outside dismissal`, await page.evaluate(`document.querySelector('#filterMenu').hidden`));
      await page.clickAt('#bulkBar .clear-selection');
      // Existing global key and command ports can retain a popup below a modal/viewer.
      await open('#hostBtn', '#hostDrop');
      await page.keyTrusted('?', { code: 'Slash', vk: 191 });
      await page.poll(`!!document.querySelector('#keysPanel')`);
      record.modal = await intersections(page, '#hostDrop', '#keysPanel');
      check(`${width}: modal retains paint/input priority`, record.modal.length > 0 && record.modal.every(p => !p.owns && p.paint.some(e => e.includes('#keysPanel'))));
      await page.keyTrusted('Escape', { vk: 27 });
      await page.poll(`!document.querySelector('#keysPanel')`);
      await invoke('workbench.openEntry', { id: `fake:${names[0]}` });
      await page.poll(`!document.querySelector('#diff').hidden`);
      record.viewer = await intersections(page, '#hostDrop', '#diff');
      check(`${width}: viewer retains paint/input priority`, record.viewer.length > 0 && record.viewer.every(p => !p.owns && p.paint.some(e => e === 'div#diff')));
      await page.keyTrusted('Escape', { vk: 27 });
      await page.poll(`document.querySelector('#diff').hidden`);
      await invoke('source.menu.close');
    }
  } finally {
    fs.writeFileSync(path.join(output(), 'measurements.json'), JSON.stringify(records, null, 2));
    await page.send('Emulation.clearDeviceMetricsOverride');
    await invoke('source.menu.close'); await invoke('menu.close'); await invoke('feed.filter.close');
    await invoke('selection.clear'); await invoke('source.select', { id: 'fake' });
    await invoke('feed.filter.clear');
    if (saved) {
      await page.evaluate(`(async()=>${KZ}.actions.anchors.setPaneWidth(${saved.width}))()`);
      await page.evaluate(`(async()=>${KZ}.actions.ui.info.split.set(${saved.split}))()`);
      await invoke('metadata.layout', { layout: saved.layout });
      await invoke('workspace.select', { space: saved.workspace });
      await invoke('source.attributes', { id: 'another', patch: { pinned: saved.pin } });
    }
    await control({ remove: names });
    await invoke('source.refresh');
  }
};

if (require.main === module) (async () => {
  const ENGINE = process.env.E2E_ENGINE || 'http://127.0.0.1:18260';
  const FAKE = process.env.E2E_FAKE || 'http://127.0.0.1:18261';
  const failures = [];
  const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok' : 'FAIL'} ${name}${detail ? ' '+detail : ''}`); if (!ok) failures.push(name); };
  const page = await CDP.launch(9434, { windowSize: '1640,1200' });
  const errors = await collectPageErrors(page);
  try {
    await page.goto(ENGINE + '/#fake');
    await page.poll(`(async()=>${KZ}.state.images.length>3000)()`, 30000);
    await module.exports({ page, ENGINE, FAKE, check });
    // Same existing exports and assertions as the ordinary feed suite.
    const control = async body => {
      const r = await fetch(FAKE + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert(r.ok, `sticky fixture control: ${r.status}`);
    };
    await require('./sticky-foot.cjs')({ page, KZ, check, capture, control });
    await require('./sticky-mixed-feed.cjs')({ page, KZ, check, capture, control });
    assert.deepEqual(errors, [], 'uncaught page errors');
    assert.deepEqual(failures, [], 'popup layering and existing sticky contracts');
  } finally { await page.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
