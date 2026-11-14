// Real rendered judgment colors: active controls, card borders and rail ticks
// consume the same semantic treatment without changing geometry or vote priority.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { workPath } = require('./paths.cjs');

const ENGINE = process.env.E2E_ENGINE ?? 'http://127.0.0.1:18260';
const KZ = '(await import("/store/instance.js")).appStore';
const POSITIVE = 'rgb(158, 206, 106)';
const COLORS = { plain: 'rgb(255, 255, 255)', none: 'rgb(26, 26, 26)',
  up: POSITIVE, down: 'rgb(255, 102, 102)', bookmark: 'rgb(56, 189, 248)', favorite: 'rgb(255, 136, 0)' };

async function run({ page, evidence = process.env.E2E_EVIDENCE ?? workPath('artifacts/judgment-colors'),
  shots = process.env.E2E_SHOTS ?? path.join(evidence, 'shots'), nativeViewport = false, captureFull, engine = ENGINE }) {
  fs.mkdirSync(evidence, { recursive: true });
  fs.mkdirSync(shots, { recursive: true });
  const records = [], failures = [];
  const frame = () => page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const invoke = (id, args) => page.evaluate(`(async () => ${KZ}.handles.invoke(${JSON.stringify(id)}, ${JSON.stringify(args)}))()`);
  const target = '.card[data-name="flux-basic.png"]';
  const entryId = 'fixture-dir:flux-basic.png';
  const set = patch => invoke('judgment.apply', { id: entryId, intent: { type: 'set', patch } });
  const capture = async name => {
    await page.poll(`(() => { const viewport = document.querySelector('#candidatesCol').getBoundingClientRect();
      const boxes = [...document.querySelectorAll('.card .imgwrap')].filter(box => {
        const r = box.getBoundingClientRect(); return r.bottom > viewport.top && r.top < viewport.bottom;
      }); return boxes.length > 0 && boxes.every(box => box.classList.contains('ic-loaded')); })()`, 20000);
    await frame();
    const image = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(image.data, 'base64'));
    await captureFull?.(name);
  };
  if(!nativeViewport)await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.goto(engine + '/#fixture-dir');
  await page.poll(`(async () => { const s = ${KZ}; return s.state.host() === 'fixture-dir' && !s.state.inventory.loading && s.state.entriesWithKnownSize().length > 1; })()`, 20000);
  await page.evaluate(`(async () => { const s = ${KZ}; s.actions.diff.hide(); s.actions.ui.setFilter('');
    if (!s.state.judgmentPrefs.revealThumbedDown) s.actions.judgments.toggleReveal();
    const i = s.state.images.findIndex(x => x.id === ${JSON.stringify(entryId)});
    if (i < 0) throw Error('missing fixed image fixture');
    s.actions.current.set('fixture-dir', 'flux-basic.png'); s.actions.feed.restoreToIndex(i); })()`);
  await page.poll(`(() => { const el = document.querySelector('${target} .imgwrap img'); return el?.complete && el.naturalWidth > 0; })()`, 20000);
  await page.poll(`!!document.querySelector('.fr-tick[data-entry-id="${entryId}"]')`, 10000);
  const original = await page.evaluate(`(async()=>{const j=(await (await fetch('/api/collections/fixture-dir/entries/flux-basic.png')).json()).judgment??{};
    return {vote:j.vote??null,favorite:j.favorite??null,bookmark:j.bookmark??null};})()`);
  try {
  await set({ vote: null, favorite: null, bookmark: null });
  await frame();
  const geometry = await page.evaluate(`(() => { const card = document.querySelector('${target}'), tick = document.querySelector('.fr-tick[data-entry-id="${entryId}"]');
    const c = card.getBoundingClientRect(), t = tick.getBoundingClientRect();
    return { cardWidth: c.width, cardHeight: c.height, tickWidth: t.width, tickHeight: t.height, upWidth: card.querySelector('.up').getBoundingClientRect().width,
      upHeight: card.querySelector('.up').getBoundingClientRect().height }; })()`);
  const cases = [
    { name: 'up-current', patch: { vote: 'up' }, treatment: 'up', current: true, click: true, shot: true },
    { name: 'up-noncurrent', patch: { vote: 'up' }, treatment: 'up', current: false, shot: true },
    { name: 'bookmark-up', patch: { vote: 'up', bookmark: true }, treatment: 'bookmark', current: true },
    { name: 'favorite-up', patch: { vote: 'up', favorite: true }, treatment: 'favorite', current: true },
    { name: 'favorite-bookmark-up', patch: { vote: 'up', favorite: true, bookmark: true }, treatment: 'favorite', current: true, shot: true },
    { name: 'down-current', patch: { vote: 'down' }, treatment: 'down', current: true },
    { name: 'down-noncurrent', patch: { vote: 'down' }, treatment: 'down', current: false },
    { name: 'bookmark-current', patch: { bookmark: true }, treatment: 'bookmark', current: true },
    { name: 'favorite-current', patch: { favorite: true }, treatment: 'favorite', current: true },
    { name: 'plain-current', patch: {}, treatment: 'current', current: true },
  ];
  for (const item of cases) {
    await set({ vote: null, favorite: null, bookmark: null, ...item.patch, ...(item.click ? { vote: null } : {}) });
    await page.evaluate(`(async () => ${KZ}.actions.current.set('fixture-dir', ${JSON.stringify(item.current ? 'flux-basic.png' : 'flux-controlnet.png')}))()`);
    await page.poll(`(async () => ${KZ}.state.cardState(${JSON.stringify(entryId)}).current === ${item.current})()`);
    if (item.click) {
      await page.clickAt(target + ' .up');
      await page.poll(`(async () => ${KZ}.state.images.find(x => x.id === ${JSON.stringify(entryId)})?.judgment?.vote === 'up')()`);
    }
    // Keep pointer-hover styling out of active-color and geometry measurements.
    const pointer = await page.evaluate('({ x: innerWidth / 2, y: document.querySelector("header").getBoundingClientRect().height / 2 })');
    await page.mouse('mouseMoved', pointer.x, pointer.y);
    await frame();
    const record = await page.evaluate(`(() => { const card = document.querySelector('${target}'), tick = document.querySelector('.fr-tick[data-entry-id="${entryId}"]');
      const c = card.getBoundingClientRect(), t = tick.getBoundingClientRect(), up = card.querySelector('.up'), down = card.querySelector('.down');
      const cs = getComputedStyle(card), ts = getComputedStyle(tick.querySelector('.fr-body')), us = getComputedStyle(up), ds = getComputedStyle(down);
      return { border: cs.borderTopColor, tick: ts.backgroundColor, button: us.color, downButton: ds.color,
        opacity: { card: cs.opacity, tick: ts.opacity, button: us.opacity },
        current: card.classList.contains('current'), tickCurrent: tick.classList.contains('current'), treatment: card.dataset.treatment, tickTreatment: tick.dataset.treatment,
        upActive: up.getAttribute('aria-pressed'), downActive: down.getAttribute('aria-pressed'),
        favoriteActive: card.querySelector('.favorite').getAttribute('aria-pressed'), bookmarkActive: card.querySelector('.bookmark').getAttribute('aria-pressed'),
        geometry: { cardWidth: c.width, cardHeight: c.height, tickWidth: t.width, tickHeight: t.height, upWidth: up.getBoundingClientRect().width, upHeight: up.getBoundingClientRect().height } }; })()`);
    records.push({ name: item.name, ...record });
    if (item.shot) await capture(item.name);
    try {
      const expected = item.treatment === 'current' ? COLORS.plain : COLORS[item.treatment];
      assert.equal(record.border, expected, `${item.name}: card border`);
      assert.equal(record.tick, expected, `${item.name}: rail tick`);
      assert.equal(record.treatment, item.treatment);
      assert.equal(record.tickTreatment, item.treatment);
      assert.equal(record.current, item.current);
      assert.equal(record.tickCurrent, item.current);
      assert.deepEqual(record.geometry, geometry, `${item.name}: stable geometry`);
      assert.deepEqual(record.opacity, { card: '1', tick: '1', button: '1' });
      assert.equal(record.upActive, String(item.patch.vote === 'up'));
      assert.equal(record.downActive, String(item.patch.vote === 'down'));
      assert.equal(record.favoriteActive, String(!!item.patch.favorite));
      assert.equal(record.bookmarkActive, String(!!item.patch.bookmark));
      if (item.patch.vote === 'up') assert.equal(record.button, POSITIVE, `${item.name}: active up button`);
      if (item.patch.vote === 'down') assert.equal(record.downButton, COLORS.down);
      console.log(`ok ${item.name}: border=${record.border} tick=${record.tick} up=${record.button}`);
    } catch (error) { failures.push(error.message); console.error(`FAIL ${error.message}`); }
  }
  fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({ geometry, records, failures }, null, 2));
  assert.deepEqual(failures, [], 'rendered judgment color failures');
  return records;
  } finally { await set(original); }
}

module.exports = { run };
if (require.main === module) (async () => {
  const page = await CDP.launch(9351, { windowSize: '1600,1200' });
  const errors = await collectPageErrors(page);
  try {
    const records = await run({ page });
    assert.deepEqual(errors, [], 'uncaught page errors');
    console.log(`PASS ${records.length} rendered judgment cases; zero page errors`);
  } finally { await page.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
