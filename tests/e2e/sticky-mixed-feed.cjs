// Sticky belongs to layout, including fitting cards entering from below.
const fs = require('node:fs');
const { workPath } = require('./paths.cjs');

module.exports = async ({ page, KZ, check, capture, control }) => {
  const prefix = 'sticky-mixed-';
  const publications = Array.from({ length: 36 }, (_, i) => ({
    name: `${prefix}${String(i).padStart(2, '0')}.png`, fixture: 'bulk',
    width: [1024, 832, 1080, 1920, 640, 768][i % 6],
    height: [1536, 1216, 1920, 1080, 360, 512][i % 6], mtime: 2100000500 - i,
  }));
  const videoFiles = [];
  const records = [];
  const frame = `(async () => { await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); })()`;
  try {
    // Real tall video bytes, using the existing fake's mutable-byte seam.
    const video = await page.evaluate(`(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 1080; canvas.height = 1920;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#285770'; ctx.fillRect(0, 0, 1080, 1920);
      ctx.fillStyle = '#477b65'; ctx.fillRect(540, 0, 540, 1920);
      const stream = canvas.captureStream(10), chunks = [];
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
      recorder.ondataavailable = e => chunks.push(e.data);
      const stopped = new Promise(r => recorder.onstop = r); recorder.start();
      await new Promise(r => setTimeout(r, 500)); recorder.stop(); await stopped;
      stream.getTracks().forEach(track => track.stop());
      let binary = ''; for (const byte of new Uint8Array(await new Blob(chunks).arrayBuffer())) binary += String.fromCharCode(byte);
      return btoa(binary);
    })()`);
    for (const i of [6, 18, 30]) {
      const name = `${prefix}${String(i).padStart(2, '0')}.webm`;
      const path = workPath('tests/.tmp-comfy', name);
      fs.writeFileSync(path, Buffer.from(video, 'base64')); videoFiles.push(path);
      publications[i] = { name, fixture: 'media/geometry.webm', mtime: 2100000500 - i };
    }
    for (let i = 36; i < 41; i++) publications.push({
      name: `${prefix}${i}.${i < 39 ? 'webm' : 'wav'}`,
      fixture: i < 39 ? 'media/geometry.webm' : 'media/workflow.wav', mtime: 2100000500 - i,
    });
    await control({ publish: publications });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(`(async () => {
      const s = ${KZ}; await s.actions.hosts.select('fake'); s.actions.folders.select('');
      s.actions.ui.setFilter('${prefix}'); await s.actions.ui.refresh();
    })()`);
    await page.poll(`(async () => ${KZ}.state.entriesWithKnownSize().length === ${publications.length})()`, 30000);

    const reveal = async (name, position) => {
      await page.evaluate(`(async () => {
        const s = ${KZ}, col = s.state.feedScrollEl(), v = s.state.feedVirtualizer();
        const index = s.state.entriesWithKnownSize().findIndex(i => s.state.images[i].filename === ${JSON.stringify(name)});
        col.scrollTop = v.getMeasurements()[index].start;
      })()`);
      await page.poll(`!!document.querySelector('.card[data-name="${name}"]')`);
      await page.evaluate(`(async () => {
        const s = ${KZ}, col = s.state.feedScrollEl(), card = document.querySelector('.card[data-name="${name}"]');
        const foot = card.querySelector('.card-foot'), r = card.getBoundingClientRect(), v = col.getBoundingClientRect();
        const css = getComputedStyle(card), inset = parseFloat(css.borderTopWidth) + parseFloat(css.paddingTop);
        const position = ${JSON.stringify(position)};
        const targetTop = position.type === 'entry'
          ? v.bottom - foot.getBoundingClientRect().height * position.fraction - inset
          : v.top - Math.max(0, r.height - col.clientHeight) * position.fraction;
        col.scrollTop += r.top - targetTop;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      })()`);
    };

    const audit = async (phase, name, position) => {
      await reveal(name, position);
      const samples = await page.evaluate(`(async () => {
        const s = ${KZ}, col = s.state.feedScrollEl(), viewport = col.getBoundingClientRect();
        const { cardHeight, gridGapPx } = await import('/store/sizes.js');
        return [...document.querySelectorAll('.card')].flatMap(card => {
          const r = card.getBoundingClientRect();
          if (r.top >= viewport.bottom || r.bottom <= viewport.top) return [];
          const foot = card.querySelector('.card-foot'), f = foot.getBoundingClientRect(), css = getComputedStyle(card);
          // Remove only the inset to observe the natural flow position. No paint
          // or application state change occurs between these synchronous reads.
          foot.style.setProperty('bottom', 'auto', 'important');
          const naturalBottom = foot.getBoundingClientRect().bottom;
          foot.style.removeProperty('bottom');
          const contentTop = r.top + parseFloat(css.borderTopWidth) + parseFloat(css.paddingTop);
          const below = naturalBottom > viewport.bottom + 1;
          const clamped = below && contentTop + f.height > viewport.bottom;
          const expected = cardHeight(s.state.cardSize(Number(card.dataset.idx)), col.clientWidth);
          const item = s.state.feedVirtualizer().getVirtualItems().find(it => it.key === s.state.images[Number(card.dataset.idx)].id);
          const bar = foot.querySelector('.media-controls'), b = bar?.getBoundingClientRect();
          const kind = card.querySelector('.media-box')?.dataset.kind;
          return [{ name: card.dataset.name, kind, height: r.height, expected, stride: item?.size, gap: gridGapPx(),
            cardTop: r.top, contentTop, footTop: f.top, footBottom: f.bottom, footHeight: f.height,
            viewportBottom: viewport.bottom, naturalBottom, below, clamped,
            tall: r.height > col.clientHeight, position: getComputedStyle(foot).position,
            delta: below ? Math.abs(clamped ? f.top - contentTop : f.bottom - viewport.bottom) : Math.abs(f.bottom - naturalBottom),
            controlsOwned: !!bar && foot.firstElementChild?.contains(bar),
            controlsVisible: !!b && b.top >= viewport.top && b.bottom <= viewport.bottom && b.top >= f.top && b.bottom <= f.bottom }];
        });
      })()`);
      records.push(...samples.map(sample => ({ phase, target: name, sample: position, ...sample })));
    };

    let firstNodeRetired = false;
    for (const [phase, height] of [['initial', 1000], ['resize', 800], ['reentry', 1000]]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width: 1600, height, deviceScaleFactor: 1, mobile: false });
      await page.evaluate(frame);
      const entries = phase === 'reentry' ? [...publications].reverse() : publications;
      for (const [i, entry] of entries.entries()) {
        await reveal(entry.name, { type: 'entry', fraction: 2 });
        if (entry.name.endsWith('.webm') || entry.name.endsWith('.wav')) {
          await page.poll(`(() => {
            const media = document.querySelector('.card[data-name="${entry.name}"] :is(video,audio)');
            return media && media.readyState >= 2;
          })()`, 20000);
        }
        if (phase === 'initial' && i === 0) await page.evaluate(`window.__stickyFirstCard = document.querySelector('.card[data-name="${entry.name}"]')`);
        for (const fraction of [.5, 1.5, 2.5]) await audit(phase, entry.name, { type: 'entry', fraction });
        const tall = await page.evaluate(`document.querySelector('.card[data-name="${entry.name}"]').getBoundingClientRect().height > document.getElementById('candidatesCol').clientHeight`);
        if (tall) for (const fraction of [.1, .3, .5]) await audit(phase, entry.name, { type: 'interior', fraction });
      }
      if (phase === 'initial') firstNodeRetired = await page.evaluate(`!window.__stickyFirstCard.isConnected`);
    }
    const remounted = await page.evaluate(`document.querySelector('.card[data-name="${publications[0].name}"]') !== window.__stickyFirstCard`);
    check('mixed sticky feed: cards actually leave and re-enter the virtual window', firstNodeRetired && remounted);

    const heights = new Map();
    for (const r of records) {
      if (!heights.has(r.name)) heights.set(r.name, r.height);
    }
    for (const phase of ['initial', 'resize', 'reentry']) {
      const phaseRecords = records.filter(r => r.phase === phase);
      const pinned = phaseRecords.filter(r => r.below && !r.clamped);
      const clamped = phaseRecords.filter(r => r.clamped);
      const wrong = list => list.filter(r => r.delta > 1);
      check(`mixed sticky feed ${phase}: every entering/tall foot pins at viewport bottom`,
        pinned.length > 0 && wrong(pinned).length === 0,
        JSON.stringify({ samples: pinned.length, failures: wrong(pinned).slice(0, 6) }));
      check(`mixed sticky feed ${phase}: short visible slivers clamp at the card content edge`,
        clamped.length > 0 && wrong(clamped).length === 0,
        JSON.stringify({ samples: clamped.length, failures: wrong(clamped).slice(0, 6) }));
      const geometryErrors = phaseRecords.filter(r => r.height !== r.expected || r.stride !== r.expected + r.gap || r.height !== heights.get(r.name));
      check(`mixed sticky feed ${phase}: every card keeps its exact height and virtual stride`,
        new Set(phaseRecords.map(r => r.name)).size === publications.length && geometryErrors.length === 0,
        JSON.stringify({ cards: new Set(phaseRecords.map(r => r.name)).size, failures: geometryErrors.slice(0, 3) }));
      const playable = phaseRecords.filter(r => r.below && !r.clamped && ['video', 'audio'].includes(r.kind));
      check(`mixed sticky feed ${phase}: pinned video/audio controls are visible in the foot`,
        playable.length > 0 && playable.every(r => r.controlsOwned && r.controlsVisible),
        JSON.stringify({ samples: playable.length, failures: playable.filter(r => !r.controlsOwned || !r.controlsVisible).slice(0, 3) }));
    }
    fs.mkdirSync(workPath('tests/e2e/.shots'), { recursive: true });
    fs.writeFileSync(workPath('tests/e2e/.shots/sticky-mixed-records.json'), JSON.stringify(records, null, 2));
    await reveal(publications[6].name, { type: 'interior', fraction: .3 });
    await page.poll(`document.querySelector('.card[data-name="${publications[6].name}"] video')?.readyState >= 2`, 20000);
    await reveal(publications[6].name, { type: 'interior', fraction: .3 });
    await capture(page, 'sticky-mixed-video-foot');
  } finally {
    await page.evaluate(`delete window.__stickyFirstCard`);
    await page.send('Emulation.clearDeviceMetricsOverride');
    await control({ remove: publications.map(entry => entry.name) });
    for (const path of videoFiles) fs.rmSync(path);
    await page.evaluate(`(async () => { const s = ${KZ}; s.actions.ui.setFilter(''); await s.actions.ui.refresh(); })()`);
  }
};
