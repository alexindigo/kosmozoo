// One inventory merge that removes or inserts more rows above the viewport
// than the virtual window's overscan reaches must keep the mounted card under
// the viewport — same DOM node, same top. The feed's compensation re-bases the
// window before it is derived, so the card never leaves it for a render.
const { sleep } = require('./cdp.cjs');

module.exports = async ({ page, FAKE, KZ, check }) => {
  const rows = 12; // more than WINDOW_PAD (10)
  const card = `.card[data-name="flux-basic.png"]`;
  const control = async body => {
    const r = await fetch(FAKE + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('merge-window fixture control failed: ' + r.status);
  };
  const refresh = () => page.evaluate(`(async()=>{await ${KZ}.actions.ui.refresh();return true})()`);
  const known = names => `(async()=>{const s=${KZ};const ids=new Set(s.state.entriesWithKnownSize().map(i=>s.state.images[i].filename));
    return ${JSON.stringify(names)}.every(n=>ids.has(n))})()`;
  const absent = names => `(async()=>{const s=${KZ};const ids=new Set(s.state.images.map(i=>i.filename));
    return ${JSON.stringify(names)}.every(n=>!ids.has(n))})()`;
  const sample = `(async()=>{const s=${KZ};const ids=s.state.entriesWithKnownSize().map(i=>s.state.images[i].filename);const el=document.querySelector('${card}');
    return {pos:ids.indexOf('flux-basic.png'),top:el?.getBoundingClientRect().top??null,scroll:s.state.feedScrollEl().scrollTop,same:!!el&&window.__mergeWindowCard===el}})()`;
  let mtime = 2100001000;
  const publish = names => control({ publish: names.map(name => ({ name, fixture: 'flux-basic.png', mtime: ++mtime })) });
  const scene = async () => {
    await page.evaluate(`(async()=>{const s=${KZ};await s.actions.hosts.select('fake');s.actions.ui.setWorkspace('details');s.actions.ui.setFilter('.png');
      s.actions.current.set('fake','flux-basic.png');s.actions.feed.restoreToIndex(s.state.currentEntry().index);return true})()`);
    await page.poll(`(async()=>${KZ}.state.feedActivity()==='settled'&&!!document.querySelector('${card}'))()`, 20000);
    await sleep(1500); // past the settle and its tidy: the position under test is the user's
    await page.poll(`(async()=>${KZ}.state.feedActivity()==='settled')()`, 20000);
    await page.evaluate(`(()=>{window.__mergeWindowCard=document.querySelector('${card}');return true})()`);
    return page.evaluate(sample);
  };
  const removed = [...Array(rows)].map((_, i) => `merge-window-removed-${i}.png`);
  const inserted = [...Array(rows)].map((_, i) => `merge-window-inserted-${i}.png`);
  try {
    await publish(removed);
    await refresh();
    await page.poll(known(removed), 90000);
    let before = await scene();
    await control({ remove: removed });
    await refresh();
    await page.poll(absent(removed), 30000);
    await sleep(500);
    let after = await page.evaluate(sample);
    check(`merge window: one merge removing ${rows} rows above the viewport keeps the mounted card and its top`,
      before.pos >= rows && after.pos === before.pos - rows && after.same && Math.abs(after.top - before.top) <= 1,
      JSON.stringify({ before, after }));

    before = await scene();
    await publish(inserted);
    await refresh();
    await page.poll(known(inserted), 90000);
    await sleep(500);
    after = await page.evaluate(sample);
    check(`merge window: inserting ${rows} rows above the viewport keeps the mounted card and its top`,
      after.pos === before.pos + rows && after.same && Math.abs(after.top - before.top) <= 1,
      JSON.stringify({ before, after }));
  } catch (error) {
    check('merge window consumer', false, error.message);
  } finally {
    await control({ remove: [...removed, ...inserted] });
    await refresh();
    await page.evaluate('delete window.__mergeWindowCard');
  }
};
