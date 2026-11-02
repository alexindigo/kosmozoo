// Observe the crop at the native consumer, without importing the view model.
module.exports = async ({ page, KZ, check, control, capture = async () => {} }) => {
  const names = ['zoom-views-a.png', 'zoom-views-b.png'];
  const source = '.infoimg[data-file="zoom-views-reference.png"] .media-box';
  const anchor = '.anchor[data-name="zoom-views-anchor.png"] .media-box';
  const invoke = (id, args = {}) => page.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const frames = () => page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const sample = (selector, key, viewer = false) => page.evaluate(`(async()=>{
    const b=document.querySelector(${JSON.stringify(selector)}),m=b?.querySelector('img,video');
    if(!m)return null;
    const r=b.getBoundingClientRect(),n=m.getBoundingClientRect(),matrix=new DOMMatrix(getComputedStyle(m).transform);
    const w=m.naturalWidth||m.videoWidth,h=m.naturalHeight||m.videoHeight;
    return {box:[r.width,r.height],native:[m.offsetWidth,m.offsetHeight],natural:[w,h],
      centre:[w*(.5+(r.x+r.width/2-n.x-n.width/2)/n.width),h*(.5+(r.y+r.height/2-n.y-n.height/2)/n.height)],
      transform:m.style.transform,matrix:[matrix.a,matrix.d,matrix.e,matrix.f],view:JSON.parse(JSON.stringify(${KZ}.actions.${viewer ? 'diff.' : ''}views.get(${JSON.stringify(key)})))};
  })()`);
  const compare = (name, before, after) => check(name,
    !!before && !!after && before.centre.every((v,i)=>Math.abs(v-after.centre[i])<=1),
    JSON.stringify({before,after}));
  const ready = async selector => {
    await page.poll(`(()=>{const b=document.querySelector(${JSON.stringify(selector)}),m=b?.querySelector('img,video');return b?.clientWidth>0&&(m?.naturalWidth||m?.videoWidth)>0&&m.offsetWidth>0})()`,20000);
    await frames();
  };
  const crop = async (selector, key, viewer = false) => {
    await ready(selector);
    await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
    const p=await page.evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(selector)}),r=b.querySelector('img,video').getBoundingClientRect();return{x:r.x+r.width*.6,y:r.y+r.height*.4}})()`);
    await page.mouse('mouseWheel',p.x,p.y,{deltaY:-90,modifiers:2});
    await page.poll(`(()=>{const m=document.querySelector(${JSON.stringify(selector)})?.querySelector('img,video');return m?.style.transform.includes('scale(')})()`);
    await page.drag(p.x,p.y,p.x+25,p.y+18);
    await frames();
    return sample(selector,key,viewer);
  };
  const select = async name => {
    await invoke('entry.select',{source:'fake',file:name});
    await invoke('feed.revealEntry',{id:'fake:'+name});
    await page.poll(`(async()=>${KZ}.state.current()?.image===${JSON.stringify(name)})()`,15000);
    await frames();
  };
  try {
    // Spatial landmarks make the full before/after captures meaningful too.
    await page.evaluate(`(async()=>{const c=document.createElement('canvas');c.width=c.height=1024;const x=c.getContext('2d');
      for(let y=0;y<8;y++)for(let z=0;z<8;z++){x.fillStyle='hsl('+((z*29+y*17)%360)+' 45% '+(30+(z+y)%3*12)+'%)';x.fillRect(z*128,y*128,128,128);x.fillStyle='#fff';x.font='28px sans-serif';x.fillText(z+','+y,z*128+36,y*128+74)}
      const blob=await new Promise(r=>c.toBlob(r,'image/png')),f=new FormData();f.set('image',new File([blob],'zoom-views-reference.png',{type:'image/png'}));
      const r=await fetch('/api/collections/fake/entries',{method:'POST',body:f});if(!r.ok)throw Error('reference upload '+r.status)})()`);
    const graph={ '1':{class_type:'LoadImage',inputs:{image:'zoom-views-reference.png'}}, '2':{class_type:'SaveImage',inputs:{images:['1',0],filename_prefix:'zoom-views'}} };
    await control({publish:names.map((name,i)=>({name,fixture:'bulk',width:i?512:1024,height:i?1024:512,graph,mtime:2100001000-i}))});
    await page.send('Emulation.setDeviceMetricsOverride',{width:1400,height:1000,deviceScaleFactor:1,mobile:false});
    await page.evaluate(`(async()=>{const s=${KZ};s.actions.diff.close();await s.actions.hosts.select('fake');s.actions.folders.select('');s.actions.ui.setFilter('zoom-views-');s.actions.ui.setWorkspace('details');s.actions.anchors.setPaneWidth(600);s.actions.ui.setInfoLayout('split');s.actions.ui.info.split.set(.4);await s.actions.ui.refresh();await Promise.all(${JSON.stringify(names)}.map(n=>fetch('/api/collections/fake/entries/'+n+'/bytes')));await s.actions.ui.refresh()})()`);
    await select(names[0]);
    const before=await crop(source,'input:fake:zoom-views-reference.png');
    check('zoom views: details has a non-centred zoomed crop',before.matrix[0]>1&&before.centre.some((v,i)=>Math.abs(v-before.natural[i]/2)>1),JSON.stringify(before));
    await capture(page,'zoom-source-before-navigation');
    await select(names[1]);await ready(source);
    compare('zoom views: next entry sharing input preserves image-space centre within 1px',before,await sample(source,'input:fake:zoom-views-reference.png'));
    await select(names[0]);await ready(source);
    compare('zoom views: previous entry sharing input preserves image-space centre within 1px',before,await sample(source,'input:fake:zoom-views-reference.png'));
    await capture(page,'zoom-source-after-navigation');
    await page.evaluate(`(async()=>${KZ}.actions.ui.info.split.set(.8))()`);await frames();
    compare('zoom views: details allocation change preserves image-space centre within 1px',before,await sample(source,'input:fake:zoom-views-reference.png'));
    // A small native image has letterboxing that changes with allocation.
    await control({publish:[{name:'zoom-views-small.png',fixture:'bulk',width:128,height:64,mtime:2100001002}]});
    await page.evaluate(`(async()=>${KZ}.actions.ui.refresh())()`);
    await select('zoom-views-small.png');
    const small='.card[data-name="zoom-views-small.png"] .media-box';
    const feedBefore=await crop(small,'fake:zoom-views-small.png');
    await page.send('Emulation.setDeviceMetricsOverride',{width:1100,height:1000,deviceScaleFactor:1,mobile:false});await frames();
    compare('zoom views: padded feed card resize preserves image-space centre within 1px',feedBefore,await sample(small,'fake:zoom-views-small.png'));
    await page.evaluate(`(async()=>${KZ}.actions.ui.setFilter('zoom-views-b'))()`);await frames();
    await page.evaluate(`(async()=>${KZ}.actions.ui.setFilter('zoom-views-'))()`);
    await select('zoom-views-small.png');await ready(small);
    compare('zoom views: feed remount preserves image-space centre within 1px',feedBefore,await sample(small,'fake:zoom-views-small.png'));
    await page.evaluate(`(async()=>{const s=${KZ},b=await(await fetch('/api/collections/fake/entries/zoom-views-small.png/bytes')).blob();await s.actions.anchors.addFiles([new File([b],'zoom-views-anchor.png',{type:'image/png'})]);s.actions.ui.setWorkspace('anchors');s.actions.anchors.setPaneWidth(300)})()`);
    const anchorBefore=await crop(anchor,'anchor:zoom-views-anchor.png');
    await page.evaluate(`(async()=>${KZ}.actions.anchors.setPaneWidth(480))()`);await frames();
    compare('zoom views: padded anchor resize preserves image-space centre within 1px',anchorBefore,await sample(anchor,'anchor:zoom-views-anchor.png'));
    await page.evaluate(`(async()=>${KZ}.actions.ui.setWorkspace('details'))()`);
    await page.evaluate(`(async()=>${KZ}.actions.ui.setWorkspace('anchors'))()`);await ready(anchor);
    compare('zoom views: anchor remount preserves image-space centre within 1px',anchorBefore,await sample(anchor,'anchor:zoom-views-anchor.png'));
    await invoke('workbench.openPair',{left:{source:'fake',file:names[0]},right:{source:'fake',file:names[1]}});
    await invoke('workbench.mode',{mode:'two-up'});
    await invoke('workbench.lock',{value:false});
    const viewer='.dz-a .media-box',viewerBefore=await crop(viewer,'fake:'+names[0],true);
    await invoke('workbench.mode',{mode:'full'});await ready(viewer);
    compare('zoom views: viewer allocation/mode change preserves image-space centre within 1px',viewerBefore,await sample(viewer,'fake:'+names[0],true));
    await page.send('Emulation.setDeviceMetricsOverride',{width:1400,height:1000,deviceScaleFactor:1,mobile:false});await frames();
    compare('zoom views: viewer resize preserves image-space centre within 1px',viewerBefore,await sample(viewer,'fake:'+names[0],true));
    await invoke('workbench.mode',{mode:'split'});await ready(viewer);
    compare('zoom views: viewer split preserves image-space centre within 1px',viewerBefore,await sample(viewer,'fake:'+names[0],true));
    // Difference must consume EVERY crop write, including in-place updates to
    // an already-present resource record, rather than only the first write.
    await invoke('workbench.openPair',{left:{source:'fake',file:'zoom-views-small.png'},right:{source:'fake',file:'zoom-views-small.png'}});
    await invoke('workbench.mode',{mode:'difference'});
    const painted = `(()=>{const c=document.querySelector('.dz-canvas');if(!c)return null;
      const w=c.width,h=c.height,d=c.getContext('2d').getImageData(0,0,w,h).data;
      let l=w,t=h,r=-1,b=-1;for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4;if(d[i]+d[i+1]+d[i+2]>20){l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y)}}
      return r>=0?{x:(l+r+1)/2,y:(t+b+1)/2,w:r-l+1,h:b-t+1}:null})()`;
    await page.poll(painted);const initialPaint=await page.evaluate(painted);
    const stage=await page.evaluate(`(()=>{const r=document.getElementById('diffStage').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    let dx=0,dy=0;
    for(const [x,y] of [[40,20],[30,15]]){
      dx+=x;dy+=y;
      await page.drag(stage.x,stage.y,stage.x+x,stage.y+y);
      const ok=await page.poll(`(()=>{const p=${painted};return p&&Math.abs(p.x-${initialPaint.x+dx})<=1&&Math.abs(p.y-${initialPaint.y+dy})<=1})()`,3000).then(()=>true,()=>false);
      check(`zoom views: Difference consumes crop write ${dx===40?1:2} at the painted pixel boundary`,ok,JSON.stringify({initial:initialPaint,dx,dy,painted:await page.evaluate(painted)}));
    }
  } finally {
    await invoke('workbench.close');
    await invoke('anchor.remove',{name:'zoom-views-anchor.png'});
    await control({remove:[...names,'zoom-views-small.png']});
    await page.evaluate(`(async()=>{const s=${KZ};for(const k of ['input:fake:zoom-views-reference.png','fake:zoom-views-small.png','anchor:zoom-views-anchor.png'])s.actions.views.set(k,null);s.actions.ui.setFilter('');s.actions.ui.setWorkspace('details');s.actions.anchors.setPaneWidth(300);await s.actions.ui.refresh()})()`);
  }
};
