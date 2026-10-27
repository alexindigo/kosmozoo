// Observe the shared display owner's native error classification at its rendered
// consumer, independently of terminal measurement failures (which are unknown).
const { CDP, collectPageErrors } = require('./cdp.cjs');
module.exports = async ({ page, ENGINE, KZ, check, capture, control }) => {
  await page.evaluate(`(async()=>{
    const {render}=await import('/vendor/solid/web.mjs'),{createComponent}=await import('/vendor/solid/solid.mjs'),{MediaBox}=await import('/components/MediaBox.js');
    window.__failureProbes=[];
    for(const kind of ['image','video','audio']){
      const root=document.createElement('div');root.dataset.failureProbe=kind;document.body.append(root);
      const dispose=render(()=>createComponent(MediaBox,{kind,src:'data:application/octet-stream;base64,bm90IGRlY29kYWJsZQ==',alt:'broken.'+kind}),root);
      window.__failureProbes.push(()=>{dispose();root.remove()});
    }
  })()`);
  try {
    for (const kind of ['image','video','audio']) {
      await page.poll(`!!document.querySelector('[data-failure-probe="${kind}"] .media-failure')`);
      const reason = kind==='image' ? "This image can't be decoded." : `Your browser can't play this ${kind} format.`;
      check(`${kind}: native decode failure renders its specific reason and download guidance`, await page.evaluate(`(()=>{const t=document.querySelector('[data-failure-probe="${kind}"] .media-failure').textContent;return t.includes(${JSON.stringify(reason)})&&t.includes('Download it to open elsewhere.')})()`));
      const colours = await page.evaluate(`(()=>{
        const root=document.querySelector('[data-failure-probe="${kind}"]'),box=root.querySelector('.media-box'),probe=document.createElement('span');
        root.appendChild(probe);probe.style.color='var(--error)';const error=getComputedStyle(probe).color;
        probe.style.color='var(--secondary)';const flash=getComputedStyle(probe).color;
        const before=getComputedStyle(box).outlineColor;
        root.classList.add('infoimg','flash');const after=getComputedStyle(box).outlineColor;
        root.classList.remove('infoimg','flash');probe.remove();return{before,after,error,flash};
      })()`);
      check(`${kind}: error outline retains the semantic error colour`,colours.before===colours.error,JSON.stringify(colours));
      check(`${kind}: activity flash outranks error through the shared colour layers`,colours.after===colours.flash,JSON.stringify(colours));
    }
  } finally {
    await page.evaluate(`window.__failureProbes.forEach(dispose=>dispose())`);
  }

  // Each fresh application has no last-good viewer side. This exercises the
  // off-DOM decode guard, not just MediaBox's own native error handler. A failed
  // replacement must still retain its good side (covered by the existing suite).
  const cases = [
    ['audio', 'failure-viewer/e2e-viewer-failure.wav'],
    ['video', 'failure-viewer/e2e-viewer-failure.webm'],
    ['image', 'failure-viewer/e2e-viewer-failure.png'],
  ];
  await control({ publish: cases.map(([,name],i)=>({name,fixture:'undecodable',mtime:2250000000-i})) });
  try {
    for (const [i,[kind,name]] of cases.entries()) {
      const viewer = await CDP.launch(9376+i,{windowSize:'1400,1000'});
      const errors = await collectPageErrors(viewer);
      try {
        await viewer.send('Emulation.setDeviceMetricsOverride',{width:1400,height:1000,deviceScaleFactor:1,mobile:false});
        await viewer.goto(ENGINE+'/');
        await viewer.poll(`!!document.querySelector('.card')`,20000);
        await viewer.evaluate(`(async()=>{const s=${KZ};await s.actions.hosts.select('fake');s.actions.ui.setWorkspace('details');s.actions.folders.select('failure-viewer');s.actions.ui.setFilter('e2e-viewer-failure');await s.actions.ui.refresh();s.handles.invoke('workbench.openPair',{left:{source:'fake',file:${JSON.stringify(name)}}})})()`);
        await viewer.poll(`!!document.querySelector('.dz-a .media-failure')`,15000);
        const reason = kind==='image' ? "This image can't be decoded." : `Your browser can't play this ${kind} format.`;
        const result = await viewer.evaluate(`(()=>{const s=document.querySelector('.dz-a .media-box'),f=s.querySelector('.media-failure');return{kind:s.dataset.kind,text:f.textContent}})()`);
        check(`${kind}: initial viewer guard failure preserves its known cause at the rendered consumer`,result.kind===kind&&result.text.includes(name)&&result.text.includes(reason)&&result.text.includes('Download it to open elsewhere.'),JSON.stringify(result));
        check(`${kind}: failed initial viewer has no uncaught exceptions`,errors.length===0,JSON.stringify(errors));
        await viewer.evaluate(`(async()=>${KZ}.actions.status.clear('transient'))()`);
        await capture(viewer,'viewer-failure-'+kind);
      } finally { await viewer.close(); }
    }
  } finally {
    await control({ remove: cases.map(([,name])=>name) });
    await page.evaluate(`(async()=>${KZ}.actions.ui.refresh())()`);
  }
};
