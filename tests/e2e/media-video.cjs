// Production listing/bytes/metadata -> shared player -> native browser outcome.
const { sleep } = require('./cdp.cjs');
module.exports = async ({ page, ENGINE, KZ, check, capture, control }) => {
  const a = 'video/fixture_e2e-media-a.webm', b = 'video/fixture_e2e-media-b.webm', mp4 = 'video/fixture_e2e-media.mp4', broken = 'video/e2e-media-broken.mov';
  const real = process.env.E2E_REAL_VIDEO_FIXTURE ? 'video/e2e-media-real.mp4' : null;
  const card = name => `.card[data-name="${name}"]`;
  const v = name => `document.querySelector('${card(name)} video')`;
  const invoke = (command, args = {}) => page.evaluate(`(async () => ${KZ}.handles.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}))()`);
  const select = async name => {
    await invoke('entry.select', { source: 'fake', file: name });
    await invoke('feed.revealEntry', { id: `fake:${name}` });
    await page.poll(`${v(name)}?.readyState >= 2`, 20000);
  };
  const bodyClick = async name => {
    const point = await page.evaluate(`(() => { const r = ${v(name)}.getBoundingClientRect(); return { x:r.left+r.width*.25, y:r.top+r.height*.35 }; })()`);
    await page.mouse('mousePressed', point.x, point.y, { clickCount: 1, buttons: 1 });
    await page.mouse('mouseReleased', point.x, point.y, { clickCount: 1, buttons: 0 });
  };
  await page.evaluate(`(() => { window.__videoEvents=[]; window.__videoEventListener=e=>{
    if(e.target.tagName==='VIDEO')window.__videoEvents.push({at:performance.now(),type:e.type,src:e.target.getAttribute('src'),time:e.target.currentTime,ready:e.target.readyState,paused:e.target.paused});
  };for(const type of ['loadstart','loadedmetadata','loadeddata','emptied','play','playing','pause','error'])document.addEventListener(type,window.__videoEventListener,true); })()`);
  try {
    await control({ publish: [
      { name: a, fixture: 'media/workflow.webm', mtime: 2100000020 },
      { name: b, fixture: 'media/workflow.webm', mtime: 2100000019 },
      { name: mp4, fixture: 'media/workflow.mp4', mtime: 2100000018 },
      { name: broken, fixture: 'undecodable', mtime: 2100000017 },
      ...(real ? [{ name: real, fixture: process.env.E2E_REAL_VIDEO_FIXTURE, mtime: 2100000016 }] : []),
    ], captureEnqueue: true });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(`(async () => { const s = ${KZ}; s.actions.diff.close(); await s.actions.hosts.select('fake');
      s.actions.ui.setWorkspace('details'); s.actions.folders.select('video'); s.actions.ui.setFilter('e2e-media'); await s.actions.ui.refresh(); })()`);
    await select(a);
    // HAVE_CURRENT_DATA precedes compositor presentation. Observe the actual
    // held frame, still paused at time zero, instead of racing that handoff.
    await page.poll(`(() => { const el=${v(a)};if(!el||el.readyState<2)return false;
      const c=document.createElement('canvas');c.width=el.videoWidth;c.height=el.videoHeight;const x=c.getContext('2d');x.drawImage(el,0,0);
      return [...x.getImageData(0,0,c.width,c.height).data].some((v,i)=>i%4!==3&&v>40); })()`, 10000);
    const first = await page.evaluate(`(() => { const el = ${v(a)}, r = el.getBoundingClientRect(), c = document.createElement('canvas');
      c.width=el.videoWidth;c.height=el.videoHeight;const ctx=c.getContext('2d');ctx.drawImage(el,0,0);
      return { paused:el.paused,time:el.currentTime,loop:el.loop,autoplay:el.autoplay,preload:el.preload,w:el.videoWidth,h:el.videoHeight,
        visible:r.width>0&&r.height>0&&r.top<innerHeight, pixels:[...ctx.getImageData(0,0,c.width,c.height).data].some((x,i)=>i%4!==3&&x>40) }; })()`);
    check('video first frame: actual decoded pixels, metadata preload, paused at zero, no autoplay/loop', first.paused && first.time === 0 && !first.loop && !first.autoplay && first.preload === 'metadata' && first.visible && first.pixels && first.w === 160 && first.h === 96, JSON.stringify(first));
    await capture(page, 'video-card-paused');
    const center = await page.evaluate(`(() => { const box=document.querySelector('${card(a)} .media-box').getBoundingClientRect(), play=document.querySelector('${card(a)} .media-play').getBoundingClientRect();
      return Math.max(Math.abs((play.left+play.right-box.left-box.right)/2),Math.abs((play.top+play.bottom-box.top-box.bottom)/2)); })()`);
    check('video play affordance shares the box center structurally', center < 0.6, String(center));
    await page.clickAt(card(a) + ' .media-play');
    await page.poll(`!${v(a)}.paused && ${v(a)}.currentTime > .1`);
    check('video play button advances native playback time', true);
    const stable = await page.evaluate(`({time:${v(a)}.currentTime,loads:window.__videoEvents.filter(e=>e.type==='loadstart'&&e.src===${v(a)}.getAttribute('src')).length})`);
    await page.evaluate(`(async()=>{const w=${KZ}.state.window;for(let i=0;i<6;i++){w.recompute();await new Promise(requestAnimationFrame)}})()`);
    await page.poll(`${v(a)}.currentTime > ${stable.time} + .1`);
    check('same-URL source-window invalidations preserve native playback and do not reload', await page.evaluate(`window.__videoEvents.filter(e=>e.type==='loadstart'&&e.src===${v(a)}.getAttribute('src')).length===${stable.loads}&&!${v(a)}.paused`));
    await capture(page, 'video-card-playing');
    await bodyClick(a); await page.poll(`${v(a)}.paused`);
    await bodyClick(a); await page.poll(`!${v(a)}.paused`);
    check('video surface click toggles pause/play without opening viewer', await page.evaluate(`(async () => !${KZ}.state.diff.open)()`));
    const top = await page.evaluate(`document.getElementById('candidatesCol').scrollTop`);
    await page.keyTrusted(' ', { code: 'Space', vk: 32 }); await page.poll(`${v(a)}.paused`);
    check('focused Space pauses and prevents native feed scrolling', top === await page.evaluate(`document.getElementById('candidatesCol').scrollTop`));
    await page.keyTrusted(' ', { code: 'Space', vk: 32 }); await page.poll(`!${v(a)}.paused`);
    await bodyClick(a); await page.poll(`${v(a)}.paused`);
    await page.clickAt(card(a) + ' textarea.pos'); await page.keyTrusted(' ', { code: 'Space', vk: 32 });
    check('Space in notes stays typing and does not toggle video', await page.evaluate(`${v(a)}.paused`));
    await page.evaluate(`document.querySelector('${card(a)} .download').focus()`);
    await page.keyTrusted(' ', { code: 'Space', vk: 32 }); await page.poll(`!${v(a)}.paused`);
    check('Space resolves focus anywhere in the containing card, including its action row', true);
    await bodyClick(a); await page.poll(`${v(a)}.paused`);
    await page.clickAt(card(a) + ' .media-loop'); await page.poll(`${v(a)}.loop`);
    await page.clickAt(card(a) + ' .media-mute'); await page.poll(`${v(a)}.muted`);
    check('per-player loop and mute controls reach the native player', true);
    await page.clickAt(card(a) + ' .media-seek');
    await page.poll(`${v(a)}.currentTime > .5 && ${v(a)}.currentTime < ${v(a)}.duration`);
    check('seek bar updates native time and elapsed/duration text', await page.evaluate(`document.querySelector('${card(a)} .media-time').textContent.includes('0:03')`));
    // Rebind via the same persisted keys UI, then return to the player.
    await invoke('keys.panel.toggle');
    await page.poll(`!![...document.querySelectorAll('.keyrow')].find(el=>el.textContent.includes('play/pause focused media'))`);
    await page.evaluate(`[...document.querySelectorAll('.keyrow')].find(el=>el.textContent.includes('play/pause focused media')).querySelector('button').click()`);
    await page.keyTrusted('p', { code: 'KeyP', vk: 80 }); await invoke('keys.panel.close');
    await bodyClick(a); await page.poll(`!${v(a)}.paused`);
    await page.keyTrusted('p', { code: 'KeyP', vk: 80 }); await page.poll(`${v(a)}.paused`);
    check('media.toggle rebind is persisted and toggles through the existing dispatcher', await page.evaluate(`fetch('/api/settings/core.keys').then(r=>r.json()).then(s=>s['media.toggle']==='p')`));
    await page.evaluate(`(async()=>${KZ}.actions.keys.resetOne('media.toggle'))()`);
    await bodyClick(a); await page.poll(`!${v(a)}.paused`);
    await select(b); await page.clickAt(card(b) + ' .media-play');
    await page.poll(`${v(a)}.paused && !${v(b)}.paused`);
    check('starting another native player pauses the first; loop stays per-player/default off', await page.evaluate(`!${v(b)}.loop`));
    await page.clickAt(card(b) + ' .media-toggle'); await page.poll(`${v(b)}.paused`);
    // Zoom-pan must suppress its trailing click.
    const point = await page.evaluate(`(() => {const r=${v(b)}.getBoundingClientRect();return{x:r.left+r.width*.25,y:r.top+r.height*.35};})()`);
    await page.mouse('mouseWheel', point.x, point.y, { deltaY: -100, modifiers: 2 });
    await page.poll(`${v(b)}.style.transform.includes('scale(')`);
    await page.drag(point.x, point.y, point.x + 30, point.y + 20);
    await sleep(100);
    check('pan drag does not toggle video', await page.evaluate(`${v(b)}.paused`));
    await page.clickAt(card(b) + ' .media-open');
    await page.poll(`document.querySelector('.dz-a video')?.readyState>=2`);
    check('open-in-viewer renders the video; difference mode disabled with exact reason', await page.evaluate(`(() => { const el=document.querySelector('#diffModes button:last-child');return !document.getElementById('diff').hidden && el.disabled && el.title==='difference mode compares still images'; })()`));
    await page.keyTrusted(' ', { code: 'Space', vk: 32 });
    await page.poll(`!document.querySelector('.dz-a video').paused`);
    check('workbench Space toggles its player', true);
    await capture(page, 'video-workbench');
    await invoke('workbench.openPair', { left: { source: 'fake', file: a }, right: { source: 'fake', file: b } });
    await page.poll(`document.querySelector('.dz-b video')?.readyState>=2`);
    for (const mode of ['two-up', 'one-up', 'split']) {
      await invoke('workbench.mode', { mode });
      await page.poll(`document.getElementById('diffStage').dataset.mode===${JSON.stringify(mode)}`);
      check(`video workbench ${mode}: retained native players, no synchronization`, await page.evaluate(`document.querySelectorAll('#diffStage video').length===2`));
    }
    await invoke('workbench.mode', { mode: 'difference' });
    check('difference semantic command also rejects non-image pairs', await page.evaluate(`(async()=>${KZ}.state.diff.mode!=='difference')()`));
    await invoke('workbench.close');
    await page.poll(`[...document.querySelectorAll('#diffStage video')].every(el=>el.paused&&!el.getAttribute('src'))`);
    check('workbench close retires playback and native sources', true);
    await select(a);
    await page.poll(`document.querySelector('#workspace .info-body').textContent.includes('A moving cosmic zoo')`, 20000);
    check('video details consume embedded parameters', await page.evaluate(`(async()=>${KZ}.state.currentEntry().entry.meta.seed===42)()`));
    await invoke('variations.open', { id: `fake:${a}` });
    await page.poll(`document.querySelectorAll('.vz-slider-row').length>0`, 20000);
    check('video Variations probe opens editable parameters', true);
    // The fixture has no denoise default axis. Explicitly enable steps so Run
    // requests non-current permutations rather than just renaming an empty set.
    await page.clickAt('.vz-slider-row[data-param-key="2.steps"] .vz-cb');
    await page.poll(`Number(document.querySelector('.vz-count').textContent)>0`);
    await page.evaluate(`(() => { const el=document.querySelector('.vz-prefix'); if(!el)throw new Error('prefix missing'); el.value='video-test_';el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    const run = await invoke('variations.run');
    console.log('VIDEO VARIATIONS RUN', JSON.stringify(run));
    console.log('VIDEO VARIATIONS RESULT', await page.evaluate(`document.querySelector('.vz-error')?.textContent`));
    const enqueues = await (await fetch((process.env.E2E_FAKE ?? 'http://127.0.0.1:18261') + '/__test/enqueues')).json();
    check('video Variations submit is accepted by fake backing', enqueues.some(row => row.prompt?.['92']?.class_type === 'SaveVideo'), JSON.stringify(enqueues.map(row=>row.prompt?.['92'])));
    await page.evaluate(`(async()=>{window.__videoLeave=${KZ}.handles.invoke('variations.close');return true})()`);
    if (await page.evaluate(`!!document.querySelector('.vz-discard')`)) await page.clickAt('.vz-discard-confirm');
    await select(a); await bodyClick(a); await page.poll(`!${v(a)}.paused`);
    await page.evaluate(`window.__retiredVideo=${v(a)}`);
    await page.evaluate(`(async()=>{const w=${KZ}.state.window;w.clear();w.recompute()})()`);
    await page.poll(`window.__retiredVideo.paused&&!window.__retiredVideo.getAttribute('src')`);
    check('src-window retirement pauses/unloads while the same card remains mounted', await page.evaluate(`${v(a)}===window.__retiredVideo`));
    await page.evaluate(`(async()=>${KZ}.state.window.coverRange(0,3))()`);
    await page.poll(`${v(a)}.readyState>=2`);
    await bodyClick(a); await page.poll(`!${v(a)}.paused`);
    await page.evaluate(`(async()=>${KZ}.actions.ui.setFilter('e2e-media.mp4'))()`);
    await page.poll(`window.__retiredVideo.paused&&!window.__retiredVideo.getAttribute('src')`);
    check('unmount/src-window retirement pauses and unloads the native player', true);
    check('MP4 fixture listed with extracted video dimensions and workflow', await page.evaluate(`(async()=>{const e=${KZ}.state.images.find(e=>e.filename===${JSON.stringify(mp4)});return e?.width===160&&e?.height===96;})()`));
    if (real) {
      const result = await page.evaluate(`(async()=>{const s=${KZ},e=s.state.images.find(e=>e.filename===${JSON.stringify(real)});
        const url='/api/collections/fake/entries/'+encodeURIComponent(${JSON.stringify(real)})+'/bytes';
        const r=await fetch(url,{headers:{Range:'bytes=0-99'}});return{w:e?.width,h:e?.height,meta:!!e?.meta,status:r.status,length:(await r.arrayBuffer()).byteLength,range:r.headers.get('Content-Range')};})()`);
      check('real MiniMax under video/: listing, 640×640, embedded metadata and exact single-range serving', result.w===640&&result.h===640&&result.meta&&result.status===206&&result.length===100&&result.range==='bytes 0-99/1107010', JSON.stringify(result));
    }
    console.log('MP4 PLAYBACK: bundled Chromium H.264 unavailable; browser codec playback is unverified in this suite');
    await page.evaluate(`(async()=>${KZ}.actions.ui.setFilter('e2e-media-broken'))()`);
    await page.poll(`!!document.querySelector('${card(broken)} .media-failure')`, 80000);
    check('undecodable video remains visible with filename/reason and card actions', await page.evaluate(`document.querySelector('${card(broken)} .media-failure').textContent.includes(${JSON.stringify(broken)})&&!!document.querySelector('${card(broken)} .download')`));
  } catch (error) {
    console.log('VIDEO FAILURE BEFORE CLEANUP', JSON.stringify(await page.evaluate(`({events:window.__videoEvents.slice(-120),videos:[...document.querySelectorAll('video')].map(el=>({src:el.getAttribute('src'),ready:el.readyState,time:el.currentTime,paused:el.paused,error:el.error?.message,phase:el.parentElement.className})),text:document.body.innerText.slice(-1800)})`)));
    await capture(page, 'video-failure-before-cleanup');
    throw error;
  } finally {
    await page.evaluate(`(() => { for(const type of ['loadstart','loadedmetadata','loadeddata','emptied','play','playing','pause','error'])document.removeEventListener(type,window.__videoEventListener,true); })()`);
    if (await page.evaluate(`!!document.querySelector('.vz-panel')`)) {
      await page.evaluate(`(async()=>{window.__videoLeave=${KZ}.handles.invoke('variations.close');return true})()`);
      if (await page.evaluate(`!!document.querySelector('.vz-discard')`)) await page.clickAt('.vz-discard-confirm');
      await page.poll(`!document.querySelector('.vz-panel')`);
    }
    await control({ remove: [a, b, mp4, broken, ...(real ? [real] : [])], captureEnqueue: false });
    await page.evaluate(`(async () => { const s=${KZ};s.actions.diff.close();s.actions.ui.setFilter('');s.actions.folders.select('');await s.actions.ui.refresh(); })()`);
  }
};
