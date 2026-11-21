// Embedded PNG metadata -> stored record -> actual rendered, scrollable Details.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const ENGINE = process.env.E2E_ENGINE;
const OUT = process.env.E2E_EVIDENCE;
const KZ = `(await import('/store/instance.js')).appStore`;

(async () => {
  const { fullTextPrompt, fullTextEnding } = await import('../helpers/full-text.mjs');
  fs.mkdirSync(OUT, { recursive: true });
  const page = await CDP.launch(19681, { windowSize: '1400,900' });
  const errors = await collectPageErrors(page);
  const selector = '.info-body [data-parameter="CLIPTextEncode.text"] .infotext';
  const element = `document.querySelector(${JSON.stringify(selector)})`;
  const shot = async name => {
    const image = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(image.data, 'base64'));
  };
  try {
    await page.goto(ENGINE + '/#fake#full-text.png');
    await page.poll(`(async()=>!!${KZ}.state.currentEntry()?.entry)()`, 20000);
    await page.evaluate(`(async()=>${KZ}.actions.ui.setWorkspace('details'))()`);
    await page.poll(`${element}?.textContent.length >= 4096`, 20000);
    const actual = await page.evaluate(`${element}.textContent`);
    assert.equal(actual, fullTextPrompt, 'Details must render every character, including whitespace');
    assert(!actual.includes('\u2026'), 'no extractor-added ellipsis');
    await page.poll(`!document.querySelector('#bootSplash') && !!document.querySelector('.media-box.ic-loaded img')`, 20000);
    await shot('details-start');
    const geometry = await page.evaluate(`(()=>{
      const text=${element}, ending=${JSON.stringify(fullTextEnding)};
      let scroller=text.parentElement;
      while(scroller && !(scroller.scrollHeight>scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller=scroller.parentElement;
      if(!scroller) throw new Error('Details has no contained scroll surface');
      scroller.scrollTop=scroller.scrollHeight;
      const range=document.createRange(), node=text.firstChild, start=node.textContent.indexOf(ending);
      range.setStart(node,start); range.setEnd(node,start+ending.length);
      const bounds=scroller.getBoundingClientRect(), panel=document.querySelector('#workspace').getBoundingClientRect();
      const rects=[...range.getClientRects()].map(rect=>rect.toJSON());
      return {length:text.textContent.length,scrollTop:scroller.scrollTop,scrollHeight:scroller.scrollHeight,
        clientHeight:scroller.clientHeight,bounds:bounds.toJSON(),panel:panel.toJSON(),rects,
        visible:rects.length>0 && rects.every(r=>r.top>=bounds.top && r.bottom<=bounds.bottom && r.left>=bounds.left && r.right<=bounds.right && r.bottom<=innerHeight),
        contained:panel.left>=0 && panel.right<=innerWidth && panel.bottom<=innerHeight+1};
    })()`);
    assert(geometry.scrollTop > 0, 'the existing Details box scrolls');
    assert(geometry.visible && geometry.contained, JSON.stringify(geometry));
    await page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await shot('details-ending');
    assert.deepEqual(errors, []);
    fs.writeFileSync(`${OUT}/result.json`, JSON.stringify({ geometry, pageErrors: errors }, null, 2));
    console.log(JSON.stringify({ passed: ['complete-10000-character-value', 'no-ellipsis', 'final-sentence-visible', 'contained-scroll'], geometry, pageErrors: errors }));
  } finally { await page.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
