// Actual standalone payload in a fresh, outbound-isolated GNU/Linux engine.
const { CDP, collectPageErrors } = require('../e2e/cdp.cjs');
const fs = require('node:fs');
const path = require('node:path');
const evidence = process.env.E2E_EVIDENCE || '/evidence';
(async () => {
  const page = await CDP.launch();
  try {
    const errors = await collectPageErrors(page);
    await page.goto(process.env.E2E_ENGINE);
    await page.poll(`(async()=>{const s=(await import('/store/instance.js')).appStore;const image=document.querySelector('.card img');return s.state.host()==='fixtures'&&s.state.images.length===1&&image?.naturalWidth===1024&&document.querySelector('.card textarea.pos')?.value==='cold Bookworm retained'})()`, 20000);
    // Read primitives and rendered values. CDP's returnByValue does not expose
    // Solid's nested Proxy as a plain object (it serializes that proxy as {}).
    const actual = await page.evaluate(`(async()=>{const s=(await import('/store/instance.js')).appStore;return{host:s.state.host(),images:s.state.images.length,bookmark:s.state.images[0].judgment.bookmark,note:s.state.images[0].judgment.notes.pos,renderedNote:document.querySelector('.card textarea.pos').value,decoded:document.querySelector('.card img').naturalWidth,modules:performance.getEntriesByType('resource').map(r=>r.name)}})()`);
    if (!actual.bookmark || actual.note !== 'cold Bookworm retained' || actual.renderedNote !== actual.note || errors.length) throw new Error(JSON.stringify({ actual, errors }));
    fs.writeFileSync(path.join(evidence, 'cold-ui.json'), JSON.stringify(actual, null, 2)+'\n');
    const shot=await page.send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(evidence, 'cold-ui.png'),Buffer.from(shot.data,'base64'));
    console.log('COLD COMPILED UI CONSUMER PASS:',JSON.stringify({host:actual.host,decoded:actual.decoded,bookmark:actual.bookmark}));
  } finally { await page.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
