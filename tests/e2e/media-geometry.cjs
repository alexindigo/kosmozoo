// Geometry measured at the consumer, independent of the production model.
module.exports = async ({ page, KZ, check, capture, control }) => {
  const names = ['geometry-video.webm', 'geometry-square.png', 'geometry-wide.png'];
  const invoke = (id, args = {}) => page.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  try {
    await control({ publish: names.map((name, i) => ({ name, fixture: ['media/geometry.webm', 'media/square.png', 'media/wide.png'][i], mtime: 2100000100-i })) });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(`(async()=>{const s=${KZ};s.actions.diff.close();s.actions.folders.select('');s.actions.ui.setFilter('geometry-');await s.actions.ui.refresh()})()`);
    for (const [i, name] of names.entries()) {
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
  } finally {
    await invoke('workbench.close');
    await control({ remove: names });
    await page.evaluate(`(async()=>{const s=${KZ};s.actions.ui.setFilter('');await s.actions.ui.refresh()})()`);
  }
};
