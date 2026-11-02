// Real feed geometry: one pinned foot owns playback, title and feedback.
module.exports = async ({ page, KZ, check, capture, control }) => {
  const names = ['sticky-foot-image.png', 'sticky-foot-video.webm', 'sticky-foot-audio.wav'];
  try {
    await control({ publish: names.map((name, i) => ({ name,
      fixture: ['media/square.png', 'media/geometry.webm', 'media/workflow.wav'][i], mtime: 2100000300 - i })) });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 600, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(`(async () => {
      const s = ${KZ}; await s.actions.hosts.select('fake'); s.actions.folders.select('');
      s.actions.ui.setFilter('sticky-foot-'); await s.actions.ui.refresh();
    })()`);
    for (const [i, name] of names.entries()) {
      // Audio's fixed face is shorter, but uses the same tall-card contract.
      await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: i === 2 ? 320 : 600, deviceScaleFactor: 1, mobile: false });
      const card = `.card[data-name="${name}"]`;
      await page.evaluate(`(async () => {
        const s = ${KZ}; s.actions.current.set('fake', ${JSON.stringify(name)});
        s.actions.feed.restoreToIndex(s.state.currentEntry().index);
      })()`);
      await page.poll(`(() => {
        const media = document.querySelector('${card} ${i === 0 ? 'img' : i === 1 ? 'video' : 'audio'}');
        return media && ${i === 0 ? 'media.naturalWidth > 0' : 'media.readyState >= 2'};
      })()`, 20000);
      const before = await page.evaluate(`document.querySelector('${card}').getBoundingClientRect().height`);
      await page.evaluate(`(async () => {
        const s = ${KZ}, col = s.state.feedScrollEl(), card = document.querySelector('${card}');
        // Leave the card's end well below the viewport, with its top above it.
        col.scrollTop += card.getBoundingClientRect().top - col.getBoundingClientRect().top + 20;
      })()`);
      await page.poll(`(async () => ${KZ}.state.feedActivity() === 'settled')()`);
      const result = await page.evaluate(`(async () => {
        const s = ${KZ}, col = s.state.feedScrollEl(), card = document.querySelector('${card}');
        const foot = card.querySelector('.card-foot'), controls = card.querySelector('.media-controls');
        const box = card.querySelector('.media-box'), block = card.querySelector('.media-block');
        const r = e => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
        const f = r(foot), v = r(col), bar = controls && r(controls);
        const { cardHeight, gridGapPx } = await import('/store/sizes.js');
        const expected = cardHeight(s.state.cardSize(Number(card.dataset.idx)), col.clientWidth);
        const item = s.state.feedVirtualizer().getVirtualItems().find(it => it.key === s.state.images[Number(card.dataset.idx)].id);
        return { viewport: v, card: r(card), foot: f, bar, expected, stride: item?.size, gap: gridGapPx(),
          tall: card.getBoundingClientRect().height > col.clientHeight, delta: Math.abs(f.bottom - v.bottom),
          rows: card.querySelectorAll('.media-controls-slot').length,
          owned: !!controls && foot.firstElementChild?.classList.contains('media-controls-slot') && foot.firstElementChild.contains(controls),
          visible: !!bar && bar.top >= v.top && bar.bottom <= v.bottom && bar.top >= f.top && bar.bottom <= f.bottom,
          localRowRemoved: Math.abs(r(block).bottom - r(box).bottom) <= 1,
          titleAndNotes: !!foot.querySelector('.ctitle') && foot.querySelectorAll('textarea').length === 2 };
      })()`);
      check(`${name}: tall-card foot pins title/feedback at the viewport bottom`,
        result.tall && result.card.top < result.viewport.top && result.card.bottom > result.viewport.bottom + 1 && result.delta <= 1 && result.titleAndNotes,
        JSON.stringify(result));
      check(`${name}: exact card height and virtual stride survive scrolling`,
        result.card.height === before && result.card.height === result.expected && result.stride === result.expected + result.gap, JSON.stringify(result));
      if (i > 0) {
        check(`${name}: one visible controls row is first inside the sticky foot, with no old local row`,
          result.rows === 1 && result.owned && result.visible && result.localRowRemoved, JSON.stringify(result));
        if (result.owned && result.visible) {
          const point = await page.evaluate(`(() => {
            const r = document.querySelector('${card} .media-loop').getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          })()`);
          for (const enabled of [true, false]) {
            await page.mouse('mousePressed', point.x, point.y, { clickCount: 1, buttons: 1 });
            await page.mouse('mouseReleased', point.x, point.y, { clickCount: 1, buttons: 0 });
            await page.poll(`document.querySelector('${card} ${i === 1 ? 'video' : 'audio'}').loop === ${enabled}`);
          }
          check(`${name}: trusted clicks on the pinned controls reach the native player`, true);
        }
        if (i === 1 && result.owned && result.visible) await capture(page, 'sticky-video-foot');
      }
    }
  } finally {
    await page.send('Emulation.clearDeviceMetricsOverride');
    await control({ remove: names });
    await page.evaluate(`(async () => { const s = ${KZ}; s.actions.ui.setFilter(''); await s.actions.ui.refresh(); })()`);
  }
};
