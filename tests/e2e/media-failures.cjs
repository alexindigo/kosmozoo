// Observe the shared display owner's native error classification at its rendered
// consumer, independently of terminal measurement failures (which are unknown).
module.exports = async ({ page, check }) => {
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
    }
  } finally {
    await page.evaluate(`window.__failureProbes.forEach(dispose=>dispose())`);
  }
};
