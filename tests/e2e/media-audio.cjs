// Audio uses the production registry/size owner/player/metadata/commands.
module.exports = async ({ page, ENGINE, KZ, check, capture, control }) => {
  const formats = { flac: 'audio/flac', mp3: 'audio/mpeg', opus: 'audio/ogg; codecs="opus"', wav: 'audio/wav' };
  const names = Object.keys(formats).map(ext => `audio/fixture_e2e-audio.${ext}`);
  const peer = 'audio/fixture_e2e-audio-peer.flac', video = 'audio/e2e-audio-peer.webm', broken = 'audio/e2e-audio-broken.wav';
  const card = name => `.card[data-name="${name}"]`;
  const audio = name => `document.querySelector('${card(name)} audio')`;
  const invoke = (command, args = {}) => page.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(command)},${JSON.stringify(args)}))()`);
  const select = async name => {
    await invoke('entry.select', { source: 'fake', file: name });
    await invoke('feed.revealEntry', { id: `fake:${name}` });
    await page.poll(`!!${audio(name)}`, 15000);
  };
  const clickBody = async name => {
    const p = await page.evaluate(`(()=>{const r=document.querySelector('${card(name)} .media-box').getBoundingClientRect();return{x:r.left+r.width*.1,y:r.top+r.height*.2}})()`);
    await page.mouse('mousePressed', p.x, p.y, { clickCount: 1, buttons: 1 });
    await page.mouse('mouseReleased', p.x, p.y, { clickCount: 1, buttons: 0 });
  };
  const closeVariations = async () => {
    if (!await page.evaluate(`!!document.querySelector('.vz-panel')`)) return;
    await page.evaluate(`(async()=>{window.__audioLeave=${KZ}.handles.invoke('variations.close');return true})()`);
    if (await page.evaluate(`!!document.querySelector('.vz-discard')`)) await page.clickAt('.vz-discard-confirm');
    await page.poll(`!document.querySelector('.vz-panel')`);
  };
  await page.evaluate(`(()=>{window.__audioEvents=[];window.__audioEventListener=e=>{if(e.target.tagName==='AUDIO')window.__audioEvents.push({type:e.type,src:e.target.getAttribute('src'),time:e.target.currentTime,ready:e.target.readyState,paused:e.target.paused})};for(const t of ['loadstart','loadeddata','play','pause','emptied','error'])document.addEventListener(t,window.__audioEventListener,true)})()`);
  try {
    await control({ publish: [
      ...names.map((name, i) => ({ name, fixture: `media/workflow.${Object.keys(formats)[i]}`, mtime: 2110000030 - i })),
      { name: peer, fixture: 'media/workflow.flac', mtime: 2110000020 },
      { name: video, fixture: 'media/workflow.webm', mtime: 2110000019 },
      { name: broken, fixture: 'undecodable', mtime: 2110000018 },
    ], captureEnqueue: true });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(`(async()=>{const s=${KZ};s.actions.diff.close();await s.actions.hosts.select('fake');s.actions.ui.setWorkspace('details');s.actions.folders.select('audio');s.actions.ui.setFilter('e2e-audio');await s.actions.ui.refresh()})()`);
    const decoded = [];
    for (const [i, [ext, mime]] of Object.entries(Object.entries(formats))) {
      const name = names[Number(i)];
      await select(name);
      await page.poll(`(async()=>${KZ}.state.currentEntry()?.entry.meta?.seed===42)()`, 20000);
      await page.poll(`document.querySelector('#workspace .info-body').textContent.includes('A singing cosmic zoo')`, 20000);
      // CDP returnByValue does not materialize nested Solid proxies. Read the
      // lineage scalar at its consumer, alongside the rendered geometry.
      const shape = await page.evaluate(`(async()=>{const s=${KZ},e=s.state.images.find(e=>e.filename===${JSON.stringify(name)}),n=s.state.imageIdxById().get(e.id),size=s.state.cardSize(n),r=document.querySelector('${card(name)} .media-box').getBoundingClientRect(),cr=document.querySelector('${card(name)}').getBoundingClientRect(),m=await import('/store/sizes.js');return{size,ratio:r.width/r.height,height:cr.height,expected:m.cardHeight(size,s.state.feedScrollEl().clientWidth),prompt:e.meta.prompt,lineageSource:e.meta.lineage?.source,word:document.querySelector('${card(name)} .download').title}})()`);
      check(`${ext}: listing/metadata/lineage and fixed 1024×160 geometry reach the rendered card`, shape.size.w===1024 && shape.size.h===160 && Math.abs(shape.ratio-6.4)<.01 && Math.abs(shape.height-shape.expected)<.1 && shape.prompt==='A singing cosmic zoo' && shape.lineageSource==='fake:original.png' && shape.word.includes('audio file'), JSON.stringify(shape));
      await page.poll(`${audio(name)}.readyState>=2 || !!${audio(name)}.error`, 20000);
      const state = await page.evaluate(`({ready:${audio(name)}.readyState,error:${audio(name)}.error?.message,canPlay:${audio(name)}.canPlayType(${JSON.stringify(mime)}),paused:${audio(name)}.paused,time:${audio(name)}.currentTime,loop:${audio(name)}.loop,autoplay:${audio(name)}.autoplay})`);
      console.log('AUDIO DECODE', ext, JSON.stringify(state));
      if (state.ready<2) {
        check(`${ext}: unsupported playback keeps filename/reason/actions visible`, await page.evaluate(`!!document.querySelector('${card(name)} .media-failure')&&!!document.querySelector('${card(name)} .download')`));
        console.log(`UNVERIFIED PLAYBACK: ${ext}; listing and embedded metadata verified`);
        continue;
      }
      decoded.push(name);
      check(`${ext}: paused at zero, no autoplay, loop defaults off`, state.paused && state.time===0 && !state.loop && !state.autoplay, JSON.stringify(state));
      check(`${ext}: compact face shows primary play beside duration, without duplicate filename`, await page.evaluate(`(()=>{const f=document.querySelector('${card(name)} .media-audio-face'),p=f.querySelector('.media-play'),t=f.querySelector('.media-duration'),a=p.getBoundingClientRect(),b=t.getBoundingClientRect();return p.classList.contains('votebtn')&&t.textContent==='0:03'&&!f.textContent.includes(${JSON.stringify(name)})&&a.right<b.left&&Math.abs((a.top+a.bottom-b.top-b.bottom)/2)<1})()`));
      if (ext==='flac') await capture(page,'audio-card-paused');
      await page.clickAt(card(name)+' .media-play');
      await page.poll(`!${audio(name)}.paused&&${audio(name)}.currentTime>.1`);
      check(`${ext}: real play button advances native audio time`, true);
      if (ext==='flac') await capture(page,'audio-card-playing');
      const stable = await page.evaluate(`({time:${audio(name)}.currentTime,loads:window.__audioEvents.filter(e=>e.type==='loadstart'&&e.src===${audio(name)}.getAttribute('src')).length})`);
      await page.evaluate(`(async()=>{for(let i=0;i<6;i++){${KZ}.state.window.recompute();await new Promise(requestAnimationFrame)}})()`);
      await page.poll(`${audio(name)}.currentTime>${stable.time}+.1`);
      check(`${ext}: same-URL invalidation preserves playback without reload`, await page.evaluate(`!${audio(name)}.paused&&window.__audioEvents.filter(e=>e.type==='loadstart'&&e.src===${audio(name)}.getAttribute('src')).length===${stable.loads}`));
      await clickBody(name); await page.poll(`${audio(name)}.paused`);
      await clickBody(name); await page.poll(`!${audio(name)}.paused`);
      check(`${ext}: surface click toggles without opening viewer`, await page.evaluate(`(async()=>!${KZ}.state.diff.open)()`));
      const top = await page.evaluate(`document.getElementById('candidatesCol').scrollTop`);
      await page.keyTrusted(' ',{code:'Space',vk:32}); await page.poll(`${audio(name)}.paused`);
      check(`${ext}: focused Space pauses and prevents feed scroll`, top===await page.evaluate(`document.getElementById('candidatesCol').scrollTop`));
      await page.clickAt(card(name)+' textarea.pos');await page.keyTrusted(' ',{code:'Space',vk:32});
      check(`${ext}: typing Space leaves player paused`, await page.evaluate(`${audio(name)}.paused`));
      await page.evaluate(`document.querySelector('${card(name)} .download').focus()`);
      await page.keyTrusted(' ',{code:'Space',vk:32});await page.poll(`!${audio(name)}.paused`);
      await page.clickAt(card(name)+' .media-toggle');await page.poll(`${audio(name)}.paused`);
      await page.clickAt(card(name)+' .media-loop');await page.poll(`${audio(name)}.loop`);
      await page.clickAt(card(name)+' .media-mute');await page.poll(`${audio(name)}.muted`);
      await page.clickAt(card(name)+' .media-seek');await page.poll(`${audio(name)}.currentTime>.5`);
      check(`${ext}: seek/time/mute/loop controls reach native audio`, await page.evaluate(`document.querySelector('${card(name)} .media-time').textContent.includes('0:03')`));
      await page.clickAt(card(name)+' .media-loop');await page.poll(`!${audio(name)}.loop`);
      await page.clickAt(card(name)+' .media-open');await page.poll(`document.querySelector('.dz-a audio')?.readyState>=2`);
      check(`${ext}: audio viewer has no view switcher or open button`, await page.evaluate(`!document.getElementById('diff').hidden&&!document.querySelector('#diffModes')&&!document.querySelector('#diff .media-open')`));
      check(`${ext}: single audio panel is centered and never inherits a clipped comparison layout`, await page.evaluate(`(()=>{const s=document.getElementById('diffStage').getBoundingClientRect(),c=document.querySelector('.dz-a'),r=c.getBoundingClientRect(),b=c.querySelector('.media-box').getBoundingClientRect();return getComputedStyle(c).clipPath==='none'&&Math.abs((b.left+b.right-s.left-s.right)/2)<1&&b.left>=r.left&&b.right<=r.right})()`));
      check(`${ext}: audio uses the full-width bottom dock directly above the toolbar`,await page.evaluate(`(()=>{const c=document.querySelector('#diffMedia .media-controls').getBoundingClientRect(),b=document.getElementById('diffBar').getBoundingClientRect();return Math.abs(c.bottom-b.top)<=1&&Math.abs(c.left-b.left)<=1&&Math.abs(c.right-b.right)<=1&&!document.querySelector('#diffStage .media-controls')})()`));
      await page.keyTrusted(' ',{code:'Space',vk:32});await page.poll(`!document.querySelector('.dz-a audio').paused&&document.querySelector('.dz-a audio').currentTime>.05`);
      if(ext==='flac')await capture(page,'audio-workbench');
      check(`${ext}: workbench Space advances audio`,true);
      await invoke('workbench.close');await page.poll(`[...document.querySelectorAll('#diffStage audio')].every(e=>e.paused&&!e.getAttribute('src'))`);
      await invoke('variations.open',{id:`fake:${name}`});await page.poll(`document.querySelectorAll('.vz-slider-row').length>0`,20000);
      await page.clickAt('.vz-slider-row[data-param-key="2.steps"] .checkbox');await page.poll(`Number(document.querySelector('.vz-count').textContent)>0`);
      const run = await invoke('variations.run');
      const enqueues = await (await fetch((process.env.E2E_FAKE??'http://127.0.0.1:18261')+'/__test/enqueues')).json();
      check(`${ext}: embedded graph probes and Variations submits SaveAudio jobs`, run?.status==='submitted' && run.submitted===run.total && run.submitted>0 && enqueues.some(r=>r.prompt?.['92']?.class_type==='SaveAudio'),JSON.stringify(run));
      await closeVariations();
    }
    check('guest browser decodes at least one audio fixture',decoded.length>0,JSON.stringify(decoded));
    const name=decoded[0];
    await select(name);
    await invoke('keys.panel.toggle');
    await page.poll(`!![...document.querySelectorAll('.keyrow')].find(e=>e.textContent.includes('play/pause focused media'))`);
    await page.evaluate(`[...document.querySelectorAll('.keyrow')].find(e=>e.textContent.includes('play/pause focused media')).querySelector('button').click()`);
    await page.keyTrusted('p',{code:'KeyP',vk:80});await invoke('keys.panel.close');
    await clickBody(name);await page.poll(`!${audio(name)}.paused`);
    await page.keyTrusted('p',{code:'KeyP',vk:80});await page.poll(`${audio(name)}.paused`);
    check('audio honors the persisted media.toggle rebind',await page.evaluate(`fetch('/api/settings/core.keys').then(r=>r.json()).then(s=>s['media.toggle']==='p')`));
    await page.evaluate(`(async()=>${KZ}.actions.keys.resetOne('media.toggle'))()`);
    await select(name);await clickBody(name);await page.poll(`!${audio(name)}.paused`);
    await select(peer);await page.poll(`${audio(peer)}.readyState>=2`);await page.clickAt(card(peer)+' .media-play');
    await page.poll(`${audio(name)}.paused&&!${audio(peer)}.paused`);
    check('starting another audio player pauses the first; loop is local/default off',await page.evaluate(`!${audio(peer)}.loop`));
    await invoke('entry.select',{source:'fake',file:video});await invoke('feed.revealEntry',{id:`fake:${video}`});
    await page.poll(`document.querySelector('${card(video)} video')?.readyState>=2`);await page.clickAt(card(video)+' .media-play');
    await page.poll(`${audio(peer)}.paused&&!document.querySelector('${card(video)} video').paused`);
    check('native video and audio share exclusive playback ownership',true);
    await select(name);await page.clickAt(card(name)+' .media-play');await page.poll(`!${audio(name)}.paused`);
    await page.evaluate(`window.__retiredAudio=${audio(name)}`);
    await page.evaluate(`(async()=>{const w=${KZ}.state.window;w.clear();w.recompute()})()`);
    await page.poll(`window.__retiredAudio.paused&&!window.__retiredAudio.getAttribute('src')`);
    check('audio source-window retirement pauses/unloads the still-mounted native consumer',await page.evaluate(`${audio(name)}===window.__retiredAudio`));
    await page.evaluate(`(async()=>${KZ}.state.window.coverRange(0,6))()`);await page.poll(`${audio(name)}.readyState>=2`);
    await page.clickAt(card(name)+' .media-play');await page.poll(`!${audio(name)}.paused`);
    await invoke('workbench.openPair',{left:{source:'fake',file:name},right:{source:'fake',file:peer}});
    await page.poll(`document.querySelector('.dz-a audio')?.readyState>=2`);
    for(const mode of ['two-up','one-up','split']){
      const before=await page.evaluate(`(async()=>${KZ}.state.diff.mode)()`);
      await invoke('workbench.mode',{mode});
      check(`audio viewer rejects ${mode} and retains its single player`,await page.evaluate(`(async()=>${KZ}.state.diff.mode===${JSON.stringify(before)}&&document.querySelectorAll('#diffStage audio').length===1)()`));
    }
    await invoke('workbench.mode',{mode:'difference'});
    check('Difference semantic command rejects audio pairs',await page.evaluate(`(async()=>${KZ}.state.diff.mode!=='difference')()`));
    await invoke('workbench.close');
    await page.evaluate(`(async()=>${KZ}.actions.ui.setFilter('e2e-audio-broken'))()`);
    await page.poll(`!!document.querySelector('${card(broken)} .media-failure')`,20000);
    check('broken audio stays in its fixed box with specific reason/actions and matching footer count',await page.evaluate(`(async()=>{const s=${KZ},e=s.state.images.find(e=>e.filename===${JSON.stringify(broken)}),r=document.querySelector('${card(broken)} .media-box').getBoundingClientRect(),text=document.querySelector('${card(broken)} .media-failure').textContent;return s.state.entriesWithKnownSize().length===1&&s.state.pendingSizeCount()===0&&s.state.cardSize(s.state.imageIdxById().get(e.id)).h===160&&Math.abs(r.width/r.height-6.4)<.01&&document.querySelectorAll('.card[data-name]').length===1&&document.querySelector('.endoflist').textContent.includes('all 1 matching')&&!!document.querySelector('${card(broken)} .download')&&text.includes(${JSON.stringify(broken)})&&text.includes("Your browser can't play this audio format.")&&text.includes('Download it to open elsewhere.')})()`));
    check('unmount retires the original audio consumer',await page.evaluate(`window.__retiredAudio.paused&&!window.__retiredAudio.getAttribute('src')&&!window.__retiredAudio.isConnected`));
  } catch(error) {
    console.log('AUDIO FAILURE BEFORE CLEANUP',JSON.stringify(await page.evaluate(`({events:window.__audioEvents.slice(-100),players:[...document.querySelectorAll('audio')].map(e=>({src:e.getAttribute('src'),ready:e.readyState,time:e.currentTime,paused:e.paused,error:e.error?.message})),body:document.body.innerText.slice(-3000)})`)));
    await capture(page,'audio-failure-before-cleanup');throw error;
  } finally {
    await closeVariations();
    await page.evaluate(`(()=>{for(const t of ['loadstart','loadeddata','play','pause','emptied','error'])document.removeEventListener(t,window.__audioEventListener,true)})()`);
    await control({remove:[...names,peer,video,broken],captureEnqueue:false});
    await page.evaluate(`(async()=>{const s=${KZ};s.actions.diff.close();s.actions.ui.setFilter('');s.actions.folders.select('');await s.actions.ui.refresh()})()`);
  }
};
