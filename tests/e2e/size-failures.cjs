// Real fake-Comfy bytes -> production engine -> measurement owner -> visible card.
const fs = require('node:fs');
const { temporaryPath } = require('./paths.cjs');
const { sleep } = require('./cdp.cjs');

module.exports = async function sizeFailures({ page, ENGINE, KZ, check, capture }) {
  const fake = process.env.E2E_FAKE ?? 'http://127.0.0.1:18261';
  const names = ['e2e-size-failure-broken.png', 'e2e-size-failure-good-a.png', 'e2e-size-failure-good-b.png'];
  const control = async body => {
    const response = await fetch(fake + '/__test/activity', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error('size fixture publication failed');
  };
  const card = '.card[data-name="e2e-size-failure-broken.png"]';
  const audit = `(async () => {
    const s = ${KZ}, list = s.state.entriesWithKnownSize();
    const idx = s.state.images.findIndex(e => e.filename === ${JSON.stringify(names[0])});
    const card = document.querySelector('${card}'), box = card?.querySelector('.imgwrap');
    const { cardHeight } = await import('/store/sizes.js');
    const rect = box?.getBoundingClientRect(), error = box?.querySelector('.media-failure');
    const er = error?.getBoundingClientRect();
    return { size: s.state.cardSize(idx), failed: s.state.sizeFailed(s.state.images[idx]?.id),
      ready: list.length, pending: s.state.pendingSizeCount(), view: s.state.view().length,
      cards: document.querySelectorAll('.card').length,
      footer: document.querySelector('.endoflist')?.textContent,
      reason: error?.textContent, square: rect ? Math.abs(rect.width - rect.height) : null,
      centered: er && rect ? Math.max(Math.abs((er.left + er.right - rect.left - rect.right)/2), Math.abs((er.top + er.bottom - rect.top - rect.bottom)/2)) : null,
      heightDelta: card ? Math.abs(card.getBoundingClientRect().height - cardHeight(s.state.cardSize(idx), s.state.feedScrollEl().clientWidth)) : null,
      controls: card ? ['up','down','favorite','bookmark','download','delete'].every(c => !!card.querySelector('button.' + c + ':not(:disabled)')) : false,
      notes: card?.querySelectorAll('textarea').length,
      decodedGood: [...document.querySelectorAll('.card:not([data-name="${names[0]}"]) img')].filter(img => img.naturalWidth > 0).length,
    };
  })()`;
  let downloadDir;
  try {
    await control({ publish: names.map((name, i) => ({ name, fixture: i === 0 ? 'undecodable' : 'bulk', mtime: 2100000000 - i })) });
    await page.evaluate(`(async () => {
      const s = ${KZ}; await s.actions.hosts.select('fake');
      s.actions.ui.setFilter('e2e-size-failure-'); await s.actions.images.reload();
    })()`);
    await page.poll(`(async () => ${KZ}.state.view().length === 3 && ${KZ}.state.pendingSizeCount() > 0)()`, 10000);
    const pending = await page.evaluate(audit);
    check('failure pending: ready + pending partitions the view; footer counts only feed-ready entries',
      pending.ready + pending.pending === 3 && (!pending.ready || pending.footer?.includes('all ' + pending.ready + ' matching')), JSON.stringify(pending));
    await page.poll(`(async () => ${KZ}.state.pendingSizeCount() === 0 && document.querySelector('${card} .media-failure'))()`, 80000);
    await page.poll(`(async () => (await ${audit}).decodedGood === 2)()`, 20000);
    await page.evaluate(`(async () => {
      const s = ${KZ}; s.actions.current.set('fake', ${JSON.stringify(names[0])});
      s.actions.feed.restoreToIndex(s.state.imageIdxById().get('fake:${names[0]}'));
    })()`);
    await page.poll(`(() => {
      const r = document.querySelector('${card} .media-failure')?.getBoundingClientRect();
      const feed = document.getElementById('candidatesCol').getBoundingClientRect();
      return r && r.top >= feed.top && r.bottom <= feed.bottom;
    })()`);
    const terminal = await page.evaluate(audit);
    check('failure card: terminal 1024×1024 box beside decoded good PNGs, footer equals rendered count',
      terminal.size?.w === 1024 && terminal.size?.h === 1024 && terminal.failed &&
      terminal.ready === 3 && terminal.cards === 3 && terminal.pending === 0 && terminal.footer.includes('all 3 matching'), JSON.stringify(terminal));
    check('failure presentation: filename and reason centered inside a square, exact virtual height, normal controls/notes',
      terminal.reason.includes(names[0]) && terminal.reason.includes("can't display this file") &&
      terminal.square < 1 && terminal.centered < 1 && terminal.heightDelta === 0 && terminal.controls && terminal.notes === 2, JSON.stringify(terminal));
    await page.clickAt(card + ' .bookmark');
    await page.clickAt(card + ' textarea.pos');
    await page.send('Input.insertText', { text: 'Undecodable file remains reviewable' });
    await page.poll(`(async () => {
      const row = await (await fetch('/api/collections/fake/entries/${names[0]}')).json();
      return row.judgment?.bookmark && row.judgment?.notes?.pos === 'Undecodable file remains reviewable';
    })()`, 15000);
    check('failure actions: bookmark and note persist through the ordinary engine judgment route', true);
    downloadDir = fs.mkdtempSync(temporaryPath('kz-failure-download-'));
    await page.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
    await page.clickAt(card + ' .download');
    for (let i = 0; i < 100 && !fs.readdirSync(downloadDir).some(n => n.endsWith('.png')); i++) await sleep(50);
    const file = fs.readdirSync(downloadDir).find(n => n.endsWith('.png'));
    check('failure actions: download retains the exact undecodable bytes',
      !!file && fs.readFileSync(downloadDir + '/' + file, 'utf8') === 'not a decodable PNG\n');
    await capture(page, 'size-failure-visible');
    const before = await page.evaluate(audit);
    await page.evaluate(`(async () => ${KZ}.actions.ui.refresh())()`);
    const after = await page.evaluate(audit);
    check('failure refresh: terminal geometry, card count and footer remain stable',
      after.size?.w === 1024 && after.square === before.square && after.heightDelta === 0 && after.ready === 3 && after.cards === 3, JSON.stringify(after));
    // Remove the filename filter to exercise the non-filtered footer against the
    // same ready projection, including the default down-vote visibility filter.
    await page.evaluate(`(async () => {
      const s = ${KZ}; s.actions.ui.setFilter('');
      await s.actions.judgments.dispatch('fake:${names[1]}', { type: 'set', patch: { vote: 'down' } });
    })()`);
    const unfiltered = await page.evaluate(`(async () => {
      const s = ${KZ}; return { ready: s.state.entriesWithKnownSize().length,
        folder: s.state.folderView().length, footer: document.querySelector('.endoflist')?.textContent };
    })()`);
    check('unfiltered footer: judgment-hidden entries are not counted as feed cards',
      unfiltered.ready < unfiltered.folder && unfiltered.footer.includes('all ' + unfiltered.ready + ' images'), JSON.stringify(unfiltered));
  } catch (error) {
    console.log('SIZE FAILURE DIAGNOSTICS', JSON.stringify(await page.evaluate(audit)));
    console.log('SIZE FAILURE DISPLAYS', JSON.stringify(await page.evaluate(`(async () => {
      const s = ${KZ}; return { activity: s.state.feedActivity(), current: s.state.current(),
        cards: [...document.querySelectorAll('.card')].map(c => ({ name: c.dataset.name,
          phase: c.querySelector('.imgwrap')?.className, src: c.querySelector('img')?.getAttribute('src'),
          naturalWidth: c.querySelector('img')?.naturalWidth, top: c.getBoundingClientRect().top })),
        entries: s.state.view().map(i => ({ name: s.state.images[i].filename, hash: s.state.images[i].hash,
          size: s.state.cardSize(i), src: s.state.window.getSrc(s.state.feedPositionOf(s.state.images[i].id), s.state.images[i]) })) };
    })()`)));
    await capture(page, 'size-failure-diagnostic');
    throw error;
  } finally {
    if (downloadDir) fs.rmSync(downloadDir, { recursive: true, force: true });
    await control({ remove: names });
    await page.evaluate(`(async () => { const s = ${KZ}; s.actions.ui.setFilter(''); await s.actions.ui.refresh(); })()`);
  }
};
