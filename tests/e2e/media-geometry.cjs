// Geometry measured at the consumer, independent of the production model.
module.exports = async ({ page, KZ, check, capture, control }) => {
  const names = ['geometry-video.webm', 'geometry-square.png', 'geometry-wide.png', 'geometry-audio.wav'];
  const invoke = (id, args = {}) => page.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  try {
    await control({ publish: names.map((name, i) => ({ name, fixture: ['media/geometry.webm', 'media/square.png', 'media/wide.png', 'media/workflow.wav'][i], mtime: 2100000100-i })) });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(`(async()=>{const s=${KZ};s.actions.diff.close();s.actions.folders.select('');s.actions.ui.setFilter('geometry-');await s.actions.ui.refresh()})()`);
    for (const [i, name] of names.slice(0,3).entries()) {
      await invoke('entry.select', { source: 'fake', file: name });
      await invoke('feed.revealEntry', { id: 'fake:'+name });
      const card = `.card[data-name="${name}"]`;
      await page.poll(`(()=>{const n=document.querySelector('${card} video,${card} img');return n&&(n.videoWidth||n.naturalWidth)>0})()`, 20000);
      const r = await page.evaluate(`(async()=>{const c=document.querySelector('${card}'),b=c.querySelector('.media-box'),m=b.querySelector('img,video'),p=b.querySelector('.media-play'),bar=c.querySelector('.media-controls'),rect=e=>{const r=e?.getBoundingClientRect();return r?{x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}:null};const s=${KZ},idx=s.state.imageIdxById().get('fake:${name}'),{cardHeight,gridGapPx}=await import('/store/sizes.js'),item=s.state.feedVirtualizer().getVirtualItems().find(x=>x.key==='fake:${name}');return{box:rect(b),media:rect(m),play:rect(p),bar:rect(bar),card:rect(c),expected:cardHeight(s.state.cardSize(idx),s.state.feedScrollEl().clientWidth),stride:item?.size,gap:gridGapPx()}})()`);
      const { box:b, media:m }=r, near=(a,b)=>Math.abs(a-b)<=1;
      const height=i===0?Math.max(640,b.w*9/16):i===1?b.w:b.w*9/16;
      check(name+': box hugs natural media above the 16:9 minimum',near(b.h,height),JSON.stringify(r));
      check(name+': displayed content is centred, never enlarged, with no geometry CSS approximation',near(m.x+m.w/2,b.x+b.w/2)&&near(m.y+m.h/2,b.y+b.h/2)&&near(m.w,i===0?Math.min(640,b.w):b.w)&&near(m.h,i===0?Math.min(640,b.w):i===1?b.w:b.w/4),JSON.stringify(r));
      check(name+': card and virtualizer use the exact same total stride',r.card.h===r.expected&&r.stride===r.expected+r.gap,JSON.stringify(r));
      if(i===0){
        check('video controls form a separate adjacent row below the media box',near(r.bar.y,b.bottom)&&r.bar.bottom<=r.card.bottom,JSON.stringify(r));
        check('card play centre follows the displayed content rectangle',near(r.play.x+r.play.w/2,m.x+m.w/2)&&near(r.play.y+r.play.h/2,m.y+m.h/2),JSON.stringify(r));
      }
      await capture(page,['geometry-video-card','geometry-square-card','geometry-wide-card'][i]);
    }
    for (const [kind, name, modes] of [
      ['video',names[0],['full','two-up','one-up','split']],
      ['image',names[1],['full','two-up','one-up','split','difference']],
      ['audio',names[3],['full']],
    ]) {
      await page.evaluate(`(async()=>${KZ}.actions.views.set('fake:${name}',{version:2,s:3,cx:.4,cy:.25},{persist:false}))()`);
      await invoke('workbench.openPair',{left:{source:'fake',file:name},right:{source:'fake',file:name}});
      await page.poll(`document.querySelector('.dz-a ${kind==='image'?'img':kind}')?.${kind==='image'?'naturalWidth>0':'readyState>=2'}`);
      check(kind+': every open defaults to A-only Full despite persisted card pan/zoom',await page.evaluate(`(async()=>{const s=${KZ};return s.state.diff.mode==='full'&&!document.querySelector('.dz-b')&&Object.keys(s.state.diff.views).length===0&&s.state.views['fake:${name}'].s===3&&document.querySelector('.dz-a .dz-img').style.transform===''})()`));
      for(const mode of modes){
        await invoke('workbench.mode',{mode});
        if(mode!=='full')await page.poll(`document.querySelector('.dz-b ${kind==='image'?'img':kind}')?.${kind==='image'?'naturalWidth>0':'readyState>=2'}`);
        await page.evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
        const result=await page.evaluate(`(()=>{const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}},stage=rect(document.getElementById('diffStage')),bar=rect(document.getElementById('diffBar')),dock=document.getElementById('diffMedia');return{stage,bar,dock:dock.hidden?null:rect(dock),play:!!document.querySelector('#diff .media-play'),layers:[...document.querySelectorAll('#diffStage .dz-a,#diffStage .dz-b')].map(e=>{const n=e.querySelector('img,video,audio'),m=n.tagName==='AUDIO'?e.querySelector('.media-audio-face'):n;return{cell:rect(e),media:rect(m),natural:n.tagName==='AUDIO'?[1024,160]:[n.videoWidth||n.naturalWidth,n.videoHeight||n.naturalHeight]}})}})()`);
        const near=(a,b)=>Math.abs(a-b)<=1;
        check(kind+' '+mode+': no centre play and dock/toolbar have exact adjacent boundaries',!result.play&&(result.dock?near(result.stage.bottom,result.dock.y)&&near(result.dock.bottom,result.bar.y):near(result.stage.bottom,result.bar.y)),JSON.stringify(result));
        if(mode!=='difference'){
          check(kind+' '+mode+': each layer fits and centres its displayed natural rectangle',result.layers.every(({cell:c,media:m,natural:[w,h]})=>{const f=Math.min(1,c.w/w,c.h/h);return m.x>=c.x-1&&m.y>=c.y-1&&m.right<=c.right+1&&m.bottom<=c.bottom+1&&near(m.x+m.w/2,c.x+c.w/2)&&near(m.y+m.h/2,c.y+c.h/2)&&near(m.w,w*f)&&near(m.h,h*f)}),JSON.stringify(result));
        }else{
          await page.poll(`(()=>{const c=document.querySelector('.dz-canvas');return c?.width>0&&c.getContext('2d').getImageData(c.width>>1,c.height>>1,1,1).data[2]>50})()`);
          check('image difference: the actual consumer pixels use the same centred fitted rectangle',await page.evaluate(`(()=>{const c=document.querySelector('.dz-canvas'),w=c.width,h=c.height,d=c.getContext('2d').getImageData(0,0,w,h).data;let l=w,t=h,r=-1,b=-1;for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4;if(d[i+2]>50){l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y)}}const fit=Math.min(1,w/1024,h/1024),size=1024*fit;return Math.abs((l+r+1)/2-w/2)<=1&&Math.abs((t+b+1)/2-h/2)<=1&&Math.abs(r-l+1-size)<=1&&Math.abs(b-t+1-size)<=1})()`));
        }
        if(kind==='video'||mode==='full'||mode==='two-up')await capture(page,'geometry-'+kind+'-viewer-'+mode);
      }
      // A real viewer gesture changes only the session crop; reopening resets it.
      if(kind!=='audio'){
        await invoke('workbench.mode',{mode:'full'});
        const p=await page.evaluate(`(()=>{const r=document.getElementById('diffStage').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
        await page.drag(p.x,p.y,p.x+40,p.y+20);
        await page.poll(`(async()=>${KZ}.state.diff.views['fake:${name}']?.cx!==undefined&&${KZ}.state.diff.views['fake:${name}'].cx!==.5)()`);
        check(kind+': viewer gesture leaves persisted card crop intact',await page.evaluate(`(async()=>{const v=${KZ}.state.views['fake:${name}'];return v.s===3&&v.cx===.4&&v.cy===.25})()`));
      }
      await invoke('workbench.close');
      await invoke('workbench.openPair',{left:{source:'fake',file:name},right:{source:'fake',file:name}});
      check(kind+': reopening resets viewer crops and mode',await page.evaluate(`(async()=>${KZ}.state.diff.mode==='full'&&Object.keys(${KZ}.state.diff.views).length===0)()`));
      await invoke('workbench.close');
    }
  } finally {
    await invoke('workbench.close');
    await control({ remove: names });
    await page.evaluate(`(async()=>{const s=${KZ};for(const n of ${JSON.stringify(['geometry-video.webm','geometry-square.png','geometry-wide.png','geometry-audio.wav'])})s.actions.views.set('fake:'+n,null,{persist:false})})()`);
    await page.evaluate(`(async()=>{const s=${KZ};s.actions.ui.setFilter('');await s.actions.ui.refresh()})()`);
  }
};
